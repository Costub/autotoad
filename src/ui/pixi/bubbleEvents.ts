export interface BubbleEvent {
  type: 'on' | 'off';
  midi: number;
  velocity: number;
}

const queue: BubbleEvent[] = [];

export function pushBubbleEvent(event: BubbleEvent): void {
  queue.push(event);
  if (queue.length > 24) queue.shift();
}

export function drainBubbleEvents(): BubbleEvent[] {
  return queue.splice(0);
}
