export type EverportEventType =
  | 'agent:starting'
  | 'agent:ready'
  | 'agent:stopping'
  | 'agent:stopped'
  | 'relay:setup'
  | 'tunnel:creating'
  | 'tunnel:active'
  | 'tunnel:ready'
  | 'tunnel:released'
  | 'tunnel:failed';

export interface EverportEvent {
  type: EverportEventType;
  message: string;
  data?: Record<string, unknown>;
}

export type EverportEventListener = (e: EverportEvent) => void;

export class EventBus {
  private listeners = new Set<EverportEventListener>();

  on(listener: EverportEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(type: EverportEventType, message: string, data?: Record<string, unknown>): void {
    const event: EverportEvent = data ? { type, message, data } : { type, message };
    for (const l of [...this.listeners]) {
      try {
        l(event);
      } catch {
        // a broken listener must not break core flows
      }
    }
  }
}
