
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { GoogleGenAI, Modality, LiveServerMessage, Type, FunctionDeclaration } from '@google/genai';
import { SessionStatus } from './types';
import { decode, encode, decodeAudioData, blobToBase64 } from './utils/audio';

const MODEL_NAME = 'gemini-2.5-flash-native-audio-preview-12-2025';
const SYSTEM_INSTRUCTION = `You are DEJA VU, a high-performance visual assistant for the blind. 

CORE CAPABILITIES:
1. LOCATION: Use 'get_location_address' whenever the user asks "Where am I?", "What is my address?", or needs to know their current surroundings.
2. DISTANCES & INFO: Use 'googleSearch' for distances between cities/locations, product details, or any general knowledge.
3. PRODUCT SCANNING: Automatically scan the camera feed for Barcodes, QR codes, and Labels. 
4. SAFETY CHECK: Actively look for "MFG" (Manufacturing) and "EXP" (Expiration) dates. If a product is expired, warn the user immediately.
5. SAFETY: Always prioritize describing obstacles, stairs, or traffic in the immediate vicinity.

Be concise, clear, and professional. Always identify yourself as DEJA VU. If you use a tool, explain what you are doing (e.g., "Checking your GPS now...").`;

const locationTool: FunctionDeclaration = {
  name: 'get_location_address',
  description: 'Gets the users current street address and precise GPS coordinates.',
  parameters: { type: Type.OBJECT, properties: {}, required: [] },
};

export default function App() {
  const [status, setStatus] = useState<SessionStatus>(SessionStatus.IDLE);
  const [error, setError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState<string>("");

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const sessionPromiseRef = useRef<Promise<any> | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const frameIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    const message = "Welcome to DEJA VU. Tap the screen to wake the assistant.";
    const speakInstruction = () => {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(message);
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    };
    setAnnouncement(message);
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
      navigator.geolocation.getCurrentPosition(
        async (pos) => {
          try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${pos.coords.latitude}&lon=${pos.coords.longitude}&format=json`);
            const data = await res.json();
            resolve({ 
              address: data.display_name || "Unknown address", 
              latitude: pos.coords.latitude, 
              longitude: pos.coords.longitude,
              accuracy: `${Math.round(pos.coords.accuracy)} meters`
            });
          } catch { 
            resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, note: "Could not resolve street address, but have GPS coordinates." }); 
          }
        },
        (err) => resolve({ error: "Location permission denied or unavailable." }),
        { enableHighAccuracy: true, timeout: 8000 }
      );
    });
  };

  const stopSession = useCallback(() => {
    if (frameIntervalRef.current) window.clearInterval(frameIntervalRef.current);
    if (sessionPromiseRef.current) {
      sessionPromiseRef.current.then(s => { try { s.close(); } catch {} }).catch(() => {});
    }
    sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
    sourcesRef.current.clear();
    if (inputAudioCtxRef.current?.state !== 'closed') inputAudioCtxRef.current?.close();
    if (outputAudioCtxRef.current?.state !== 'closed') outputAudioCtxRef.current?.close();
    if (videoRef.current?.srcObject) (videoRef.current.srcObject as MediaStream).getTracks().forEach(t => t.stop());
    
    inputAudioCtxRef.current = null;
    outputAudioCtxRef.current = null;
    sessionPromiseRef.current = null;
    setStatus(SessionStatus.IDLE);
    nextStartTimeRef.current = 0;
    setAnnouncement("Assistant hibernating.");
  }, []);

  const startSession = async () => {
    try {
      window.speechSynthesis.cancel();
      setError(null);
      setStatus(SessionStatus.CONNECTING);
      setAnnouncement("Starting sensors.");

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
          tools: [
            { googleSearch: {} },
            { functionDeclarations: [locationTool] }
          ]
        },
        callbacks: {
          onopen: () => {
            setStatus(SessionStatus.ACTIVE);
            setAnnouncement("DEJA VU active. Monitoring vision and sensors.");
            const source = inputCtx.createMediaStreamSource(stream);
            const processor = inputCtx.createScriptProcessor(4096, 1, 1);
            processor.onaudioprocess = (e) => {
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
              const v = videoRef.current;
              const c = canvasRef.current;
              if (v && c && v.readyState >= 2) {
                const ctx = c.getContext('2d');
                c.width = 640; 
                c.height = (v.videoHeight / v.videoWidth) * 640;
                ctx?.drawImage(v, 0, 0, c.width, c.height);
                c.toBlob(async (b) => {
                  if (b) {
                    const b64 = await blobToBase64(b);
                    sessionPromise.then(s => s.sendRealtimeInput({ media: { data: b64, mimeType: 'image/jpeg' } })).catch(() => {});
                  }
                }, 'image/jpeg', 0.8);
              }
            }, 1000);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Handle Tool Calls (Location)
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                if (fc.name === 'get_location_address') {
                  const result = await fetchAddress();
                  sessionPromise.then(s => s.sendToolResponse({
                    functionResponses: { id: fc.id, name: fc.name, response: { result } }
                  })).catch(console.error);
                }
              }
            }

            // Handle Audio Output
            const audio = msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
            if (audio && outputAudioCtxRef.current) {
              const ctx = outputAudioCtxRef.current;
              if (ctx.state === 'suspended') await ctx.resume();
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buf = await decodeAudioData(decode(audio), ctx, 24000, 1);
              const src = ctx.createBufferSource();
              src.buffer = buf;
              src.connect(outputNode);
              src.addEventListener('ended', () => sourcesRef.current.delete(src));
              src.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buf.duration;
              sourcesRef.current.add(src);
            }

            if (msg.serverContent?.interrupted) {
              sourcesRef.current.forEach(s => { try { s.stop(); } catch {} });
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }
          },
          onerror: (e) => { 
            console.error("Session Error:", e);
            setError('Connection glitch. Tap to retry.'); 
            setAnnouncement("Connection interrupted. Please tap to try again.");
            stopSession(); 
          },
          onclose: () => setStatus(SessionStatus.IDLE)
        }
      });
      sessionPromiseRef.current = sessionPromise;
    } catch (err: any) {
      setError('Permissions required.');
      setAnnouncement("Camera or microphone access denied.");
      setStatus(SessionStatus.IDLE);
    }
  };

  return (
    <div className="h-screen w-screen bg-black overflow-hidden select-none">
      <video ref={videoRef} autoPlay playsInline muted className={`fixed inset-0 w-full h-full object-cover transition-opacity duration-1000 pointer-events-none ${status === SessionStatus.ACTIVE ? 'opacity-40' : 'opacity-0'}`} />
      <canvas ref={canvasRef} className="hidden" />

      <div className="sr-only" aria-live="assertive">
        {announcement}
      </div>

      <button
        onClick={() => (status === SessionStatus.ACTIVE ? stopSession() : startSession())}
        className={`w-full h-full flex flex-col items-center justify-center p-8 transition-all duration-500 active:bg-zinc-900 ${status === SessionStatus.ACTIVE ? 'bg-transparent' : 'bg-zinc-950'}`}
        aria-label={status === SessionStatus.ACTIVE ? "Assistant active. Tap to stop." : "Welcome to DEJA VU. Tap the screen to wake the assistant."}
      >
        <div className="text-center space-y-12 z-10">
          {(status === SessionStatus.IDLE || status === SessionStatus.ERROR) && (
            <>
              <div className="w-52 h-52 mx-auto rounded-full bg-yellow-400 flex flex-col items-center justify-center animate-pulse shadow-[0_0_100px_rgba(250,204,21,0.3)]">
                 <svg xmlns="http://www.w3.org/2000/svg" className="h-20 w-20 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 17h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z" />
                 </svg>
                 <span className="text-black font-black text-xs uppercase tracking-widest font-mono mt-1">START</span>
              </div>
              <div className="space-y-4">
                <h1 className="text-7xl font-black text-yellow-400 uppercase tracking-tighter italic">DEJA VU</h1>
                <p className="text-xl text-zinc-500 font-bold uppercase tracking-[0.4em]">{error || "Tap to wake"}</p>
              </div>
            </>
          )}

          {status === SessionStatus.CONNECTING && (
            <div className="space-y-8">
              <div className="w-32 h-32 mx-auto border-[12px] border-t-yellow-400 border-zinc-800 rounded-full animate-spin shadow-[0_0_40px_rgba(250,204,21,0.2)]" />
              <h2 className="text-4xl font-black text-white uppercase animate-pulse">Syncing Sensors...</h2>
            </div>
          )}

          {status === SessionStatus.ACTIVE && (
            <>
              <div className="relative h-64 flex items-center justify-center">
                <div className="absolute inset-0 border-2 border-red-600/30 animate-pulse rounded-3xl" />
                <div className="flex space-x-4 items-end h-48">
                   <div className="w-12 bg-red-600 rounded-full animate-[bounce_0.6s_infinite_0ms] h-24 shadow-[0_0_40px_rgba(220,38,38,0.5)]" />
                   <div className="w-12 bg-red-600 rounded-full animate-[bounce_0.6s_infinite_100ms] h-48 shadow-[0_0_60px_rgba(220,38,38,0.6)]" />
                   <div className="w-12 bg-red-600 rounded-full animate-[bounce_0.6s_infinite_200ms] h-32 shadow-[0_0_40px_rgba(220,38,38,0.5)]" />
                </div>
              </div>
              <div className="space-y-4">
                <div className="inline-block px-6 py-2 bg-red-600 text-white font-black uppercase tracking-widest rounded-full animate-pulse">Vision & Location Active</div>
                <h2 className="text-6xl font-black text-white uppercase tracking-tighter italic drop-shadow-2xl tracking-tighter">WATCHING</h2>
                <p className="text-zinc-400 font-bold tracking-[0.2em] uppercase">Tap to Stop</p>
              </div>
            </>
          )}
        </div>
      </button>
    </div>
  );
}
