
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { SessionStatus } from './types';
import { decode, encode, decodeAudioData, blobToBase64 } from './utils/audio';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';

const SYSTEM_INSTRUCTION = `You are DEJA VU, an AUTONOMOUS Visual Guardian for the blind. 

CRITICAL DIRECTIVE: PROACTIVE NARRATION.
- DO NOT WAIT for the user to speak. 
- START narrating immediately as soon as you see the first frame.
- You are the user's eyes. Your job is to describe the world as it changes in front of the camera.

ACTIVITY DETECTION & DANGER PROTOCOL:
1. ALWAYS-ON OBSERVATION: Describe every person, animal, and significant object you see.
2. MOTION SENSITIVITY: If anything enters the frame (a car, a person, a dog), announce it INSTANTLY.
3. DANGER WARNINGS: 
   - If a person is RUNNING toward the user, SHOUT a warning: "DANGER: Someone is running at you!"
   - If a person has a harmful object, alert them immediately.
   - If a dog is approaching quickly, say: "WARNING: A dog is coming toward you fast."
4. NARRATION STYLE: 
   - Be concise: "Person 5 feet ahead," "Door on right," "Stairs descending."
   - If the scene is quiet, provide a brief update every 15-20 seconds to confirm you are still watching (e.g., "Path is still clear").

If you detect a threat, interrupt yourself and start with "WARNING:" or "DANGER:". Your tone should be urgent for threats but calm for general narration.`;

const locationTool: FunctionDeclaration = {
  name: 'get_location_address',
  description: 'Gets the users current street address and precise GPS coordinates.',
  parameters: { type: Type.OBJECT, properties: {}, required: [] },
};

export default function App() {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");
  const [isThreatDetected, setIsThreatDetected] = useState(false);
  const [lastNarration, setLastNarration] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);
  const isShuttingDown = useRef(false);

  useEffect(() => {
    const message = "DEJA VU Guardian active. I am watching for threats, dogs, and people. Tap to start.";
    setAnnouncement(message);
    
    const speakInstruction = () => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.rate = 0.95;
      window.speechSynthesis.speak(utterance);
    };
    
    speakInstruction();
    
    const handleFirstTouch = () => {
      speakInstruction();
      window.removeEventListener('touchstart', handleFirstTouch);
      window.removeEventListener('mousedown', handleFirstTouch);
    };
    window.addEventListener('touchstart', handleFirstTouch);
    window.addEventListener('mousedown', handleFirstTouch);
    return () => {
      window.removeEventListener('touchstart', handleFirstTouch);
      window.removeEventListener('mousedown', handleFirstTouch);
    };
  }, []);

  const fetchAddress = (): Promise<any> => {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        resolve({ error: "Geolocation not supported" });
        return;
      }
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(
              `https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json`,
              { signal: controller.signal }
            );
            clearTimeout(timeoutId);
            const data = await res.json();
            resolve({ address: data.display_name || "Unknown location" });
          } catch (e) { 
            resolve({ note: "Location found but address service timed out." }); 
          }
        },
        (err) => resolve({ error: "Location access denied." }),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  };

  const stopSession = useCallback(() => {
    isShuttingDown.current = true;
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(s => {
        try { s.close(); } catch (e) {}
      }).catch(() => {});
      sessionPromiseRef.current = null;
    }

    sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
    sourcesRef.current.clear();

    if (inputAudioCtxRef.current?.state !== 'closed') inputAudioCtxRef.current?.close();
    if (outputAudioCtxRef.current?.state !== 'closed') outputAudioCtxRef.current?.close();
    
    if (videoRef.current?.srcObject) {
      (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
      videoRef.current.srcObject = null;
    }
    
    inputAudioCtxRef.current = null;
    outputAudioCtxRef.current = null;
    setStatus(SessionStatus.IDLE);
    setIsThreatDetected(false);
    nextStartTimeRef.current = 0;
    setAnnouncement("Guardian offline.");
    setTimeout(() => { isShuttingDown.current = false; }, 500);
  }, []);

  const startSession = async () => {
    try {
      window.speechSynthesis.cancel();
      setError(null);
      setStatus(SessionStatus.CONNECTING);
      setAnnouncement("Activating autonomous threat detection.");

      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, 
        audio: true 
      });
      
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(console.warn);
      }

      const inputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputCtx;
      outputAudioCtxRef.current = outputCtx;
      const outputNode = outputCtx.createGain();
      outputNode.connect(outputCtx.destination);

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: MODEL_NAME,
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } },
          systemInstruction: SYSTEM_INSTRUCTION,
          outputAudioTranscription: {}, 
          tools: [{ functionDeclarations: [locationTool] }]
        },
        callbacks: {
          onopen: () => {
            if (isShuttingDown.current) return;
            setStatus(SessionStatus.ACTIVE);
            setAnnouncement("DEJA VU is active. I am narrating your world autonomously.");
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
              if (isShuttingDown.current) return;
              const data = e.inputBuffer.getChannelData(0);
              const int16 = new Int16Array(data.length);
              for (let i = 0; i < data.length; i++) int16[i] = data[i] * 32768;
              sessionPromise.then(s => s.sendRealtimeInput({ 
                media: { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' } 
              })).catch(() => {});
            };
            source.connect(processor);
            processor.connect(inputCtx.destination);

            frameIntervalRef.current = window.setInterval(() => {
              if (isShuttingDown.current) return;
              const v = videoRef.current;
              const c = canvasRef.current;
              if (v && c && v.readyState >= 2) {
                const ctx = c.getContext('2d');
                // Use a standard analysis resolution
                c.width = 640; 
                c.height = (v.videoHeight / v.videoWidth) * 640;
                ctx?.drawImage(v, 0, 0, c.width, c.height);
                c.toBlob(async (b) => {
                  if (b && !isShuttingDown.current) {
                    const b64 = await blobToBase64(b);
                    sessionPromise.then(s => s.sendRealtimeInput({ 
                      media: { data: b64, mimeType: 'image/jpeg' } 
                    })).catch(() => {});
                  }
                }, 'image/jpeg', 0.8);
              }
            }, 600); // Faster sampling for better activity/motion detection
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (isShuttingDown.current) return;

            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'get_location_address') {
                  const result = await fetchAddress();
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result } }
                  })).catch(() => {});
                }
              }
            }

            if (msg.serverContent?.outputTranscription) {
              const text = msg.serverContent.outputTranscription.text;
              setLastNarration(text);
              const textLower = text.toLowerCase();
              const criticalKeywords = [
                "warning", "danger", "knife", "approaching", "running", "intent", 
                "alert", "weapon", "fast", "urgent", "dog", "car", "gun", 
                "threatening", "stop", "get back", "someone coming", "charging"
              ];
              if (criticalKeywords.some(word => textLower.includes(word))) {
                setIsThreatDetected(true);
                if ("vibrate" in navigator) navigator.vibrate([300, 100, 300]);
                setTimeout(() => setIsThreatDetected(false), 5000);
              }
            }

            const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio && outputAudioCtxRef.current && !isShuttingDown.current) {
              const ctx = outputAudioCtxRef.current;
              if (ctx.state === 'suspended') await ctx.resume();
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              try {
                const buf = await decodeAudioData(decode(audio), ctx, 24000, 1);
                const src = ctx.createBufferSource();
                src.buffer = buf;
                src.connect(outputNode);
                src.addEventListener('ended', () => sourcesRef.current.delete(src));
                src.start(nextStartTimeRef.current);
                nextStartTimeRef.current += buf.duration;
                sourcesRef.current.add(src);
              } catch (e) {
                console.warn("Audio decode skipped.");
              }
            }

            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch (e) {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => { 
            if (isShuttingDown.current) return;
            console.error("Live Error:", e);
            setError('Guardian down.'); 
            setAnnouncement("System error. Tap to reboot eyes.");
            stopSession(); 
          },
          onclose: () => {
            if (!isShuttingDown.current) setStatus(SessionStatus.IDLE);
          }
        }
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err: any) {
      setError('Check permissions.');
      setAnnouncement("Permission required for camera and audio.");
      setStatus(SessionStatus.IDLE);
    }
  };

  return (
    <div className={`h-screen w-screen bg-black overflow-hidden select-none flex flex-col transition-colors duration-500 ${isThreatDetected ? 'bg-red-950' : 'bg-black'}`}>
      <video ref={videoRef} autoPlay playsInline muted className={`fixed inset-0 w-full h-full object-cover transition-opacity duration-1000 pointer-events-none ${status === SessionStatus.ACTIVE ? 'opacity-50' : 'opacity-0'}`} />
      <canvas ref={canvasRef} className="hidden" />

      {/* EMERGENCY VISUAL FEEDBACK */}
      {isThreatDetected && (
        <div className="fixed inset-0 z-50 pointer-events-none flex flex-col items-center justify-center border-[40px] border-red-600 animate-pulse">
          <div className="bg-red-600 text-white px-10 py-5 rounded-full shadow-[0_0_150px_rgba(220,38,38,1)] text-center">
            <h3 className="text-5xl font-black uppercase tracking-tighter italic mb-2">THREAT ALERT</h3>
            <p className="text-xl font-bold uppercase tracking-widest opacity-90">Listen to Audio Guidance</p>
          </div>
        </div>
      )}

      {/* SCANNING OVERLAY */}
      {status === SessionStatus.ACTIVE && !isThreatDetected && (
        <div className="fixed inset-0 z-0 pointer-events-none">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[95vw] h-[95vw] border-[3px] border-yellow-400/20 rounded-full animate-ping" />
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[70vw] h-[70vw] border-[1px] border-yellow-400/40 rounded-full animate-[ping_2.5s_infinite]" />
            {/* Rapid Scanning Line */}
            <div className="absolute w-full h-[4px] bg-yellow-400/20 top-0 left-0 animate-[bounce_1.5s_infinite] shadow-[0_0_15px_rgba(250,204,21,0.5)]" />
        </div>
      )}

      <div className="sr-only" aria-live="assertive">
        {announcement}
      </div>

      <button
        onClick={() => (status === SessionStatus.ACTIVE ? stopSession() : startSession())}
        className={`flex-1 w-full flex flex-col items-center justify-center p-8 transition-all duration-500 active:bg-zinc-900 ${status === SessionStatus.ACTIVE ? 'bg-transparent' : 'bg-zinc-950'}`}
        aria-label={status === SessionStatus.ACTIVE ? "Guardian Eye is Active. Narrating world. Tap screen to stop." : "Tap the screen to activate Autonomous Visual Guardian."}
      >
        <div className="text-center space-y-10 z-10 w-full max-w-lg">
          {(status === SessionStatus.IDLE || status === SessionStatus.ERROR) && (
            <>
              <div className="w-64 h-64 mx-auto rounded-full bg-yellow-400 flex flex-col items-center justify-center animate-pulse shadow-[0_0_160px_rgba(250,204,21,0.6)]">
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-32 w-32 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                 </svg>
                 <span className="text-black font-black text-sm uppercase tracking-[0.4em] font-mono mt-2">ARM GUARDIAN</span>
              </div>
              <div className="space-y-4">
                <h1 className="text-8xl font-black text-yellow-400 uppercase tracking-tighter italic leading-none">DEJA VU</h1>
                <p className="text-2xl text-zinc-500 font-bold uppercase tracking-[0.6em]">{error || "AUTONOMOUS VISION"}</p>
              </div>
            </>
          )}

          {status === SessionStatus.CONNECTING && (
            <div className="space-y-8">
              <div className="w-40 h-40 mx-auto border-[20px] border-t-yellow-400 border-zinc-800 rounded-full animate-spin shadow-[0_0_80px_rgba(250,204,21,0.3)]" />
              <h2 className="text-5xl font-black text-white uppercase animate-pulse tracking-[0.2em]">EYE OPENING...</h2>
            </div>
          )}

          {status === SessionStatus.ACTIVE && (
            <>
              <div className="relative h-80 flex items-center justify-center">
                <div className={`absolute inset-0 border-4 transition-all duration-300 rounded-3xl animate-pulse ${isThreatDetected ? 'border-red-600 scale-125 shadow-[0_0_120px_rgba(220,38,38,0.7)]' : 'border-white/10'}`} />
                <div className="flex space-x-7 items-end h-64">
                   <div className={`w-16 rounded-full animate-[bounce_0.6s_infinite_0ms] h-32 ${isThreatDetected ? 'bg-red-600' : 'bg-yellow-400/90'}`} />
                   <div className={`w-16 rounded-full animate-[bounce_0.6s_infinite_100ms] h-60 ${isThreatDetected ? 'bg-red-600 shadow-[0_0_80px_rgba(220,38,38,1)]' : 'bg-yellow-400 shadow-[0_0_60px_rgba(250,204,21,0.7)]'}`} />
                   <div className={`w-16 rounded-full animate-[bounce_0.6s_infinite_200ms] h-40 ${isThreatDetected ? 'bg-red-600' : 'bg-yellow-400/90'}`} />
                </div>
              </div>
              <div className="space-y-6">
                <div className={`inline-block px-12 py-4 font-black uppercase tracking-widest rounded-full animate-pulse transition-all ${isThreatDetected ? 'bg-white text-red-600 scale-125' : 'bg-yellow-400 text-black'}`}>
                  {isThreatDetected ? 'THREAT DETECTED' : 'NARRATING LIVE'}
                </div>
                {lastNarration && (
                  <div className={`p-6 rounded-2xl border transition-all duration-300 ${isThreatDetected ? 'bg-red-600/30 border-red-500' : 'bg-white/5 border-white/10'} max-h-36 overflow-hidden backdrop-blur-xl`}>
                    <p className={`text-2xl font-bold italic line-clamp-2 ${isThreatDetected ? 'text-red-400' : 'text-white/80'}`}>"{lastNarration}"</p>
                  </div>
                )}
                <h2 className={`text-7xl font-black uppercase tracking-tighter italic drop-shadow-2xl transition-colors ${isThreatDetected ? 'text-red-500' : 'text-white'}`}>
                  {isThreatDetected ? 'ALERT' : 'ACTIVE'}
                </h2>
                <p className="text-zinc-500 font-bold tracking-[0.4em] uppercase text-sm">Tap screen to close eye</p>
              </div>
            </>
          )}
        </div>
      </button>
    </div>
  );
}
