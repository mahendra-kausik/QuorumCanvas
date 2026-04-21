export interface Stroke {
  id: string;
  boardId: string;
  userId: string;
  color: string;
  width: number;
  points: [number, number][];
  timestamp: number;
  action?: 'stroke' | 'undo_stroke' | 'redo_stroke';
  targetStrokeId?: string;
}

// Client → Server messages
export interface JoinMessage {
  type: 'join';
  boardId: string;
  userId: string;
}

export interface StrokeMessage {
  type: 'stroke';
  stroke: Stroke;
}

export type ClientMessage = JoinMessage | StrokeMessage;

// Server → Client messages
export interface JoinAckMessage {
  type: 'join_ack';
  boardId: string;
  strokes: Stroke[];
}

export interface StrokeBroadcastMessage {
  type: 'stroke_broadcast';
  stroke: Stroke;
}

export interface UserJoinedMessage {
  type: 'user_joined';
  userId: string;
}

export interface UserLeftMessage {
  type: 'user_left';
  userId: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
  code?: string;
  strokeId?: string;
  retryable?: boolean;
}

export type ServerMessage =
  | JoinAckMessage
  | StrokeBroadcastMessage
  | UserJoinedMessage
  | UserLeftMessage
  | ErrorMessage;
