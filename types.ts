
export enum SessionStatus {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR'
}

export interface TranscriptionMessage {
  text: string;
  type: 'user' | 'model';
  timestamp: number;
}
