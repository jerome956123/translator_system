export type LifecycleState = 'idle' | 'connecting' | 'ready' | 'listening' | 'finishing' | 'stopped' | 'error';

export class SessionLifecycle {
  private state: LifecycleState = 'idle';
  private generation = 0;

  start() {
    if (!['idle', 'stopped', 'error'].includes(this.state)) return null;
    this.generation += 1;
    this.state = 'connecting';
    return this.generation;
  }

  transition(next: LifecycleState, generation = this.generation) {
    if (generation !== this.generation) return false;
    if (this.state === 'stopped' && next !== 'connecting') return false;
    this.state = next;
    return true;
  }

  current() { return this.state; }
  token() { return this.generation; }
}
