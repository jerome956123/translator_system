export class SessionLifecycle {
    state = 'idle';
    generation = 0;
    start() {
        if (!['idle', 'stopped', 'error'].includes(this.state))
            return null;
        this.generation += 1;
        this.state = 'connecting';
        return this.generation;
    }
    transition(next, generation = this.generation) {
        if (generation !== this.generation)
            return false;
        if (this.state === 'stopped' && next !== 'connecting')
            return false;
        this.state = next;
        return true;
    }
    current() { return this.state; }
    token() { return this.generation; }
}
//# sourceMappingURL=lifecycle.js.map