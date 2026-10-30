// Local UI fixture only. It is never imported by the production app.
(() => {
  const metrics = { microphoneRequests: 0, modelConnections: 0, translationRequests: 0, audioPackets: 0 };
  function report() {
    let node = document.getElementById('qa-metrics');
    if (!node && document.body) {
      node = document.createElement('output'); node.id = 'qa-metrics'; node.hidden = true; document.body.append(node);
    }
    if (node) node.textContent = JSON.stringify(metrics);
  }
  navigator.mediaDevices.getUserMedia = async () => {
    metrics.microphoneRequests++; report();
    const context = new AudioContext(); await context.resume();
    const oscillator = context.createOscillator(); oscillator.frequency.value = 220;
    const gain = context.createGain(); gain.gain.value = 0.1;
    const destination = context.createMediaStreamDestination();
    oscillator.connect(gain); gain.connect(destination); oscillator.start();
    for (const track of destination.stream.getTracks()) {
      const stop = track.stop.bind(track); let stopped = false;
      track.stop = () => { if (stopped) return; stopped = true; stop(); oscillator.stop(); void context.close(); };
    }
    return destination.stream;
  };
  class TestSocket {
    static OPEN = 1; static CLOSING = 2;
    readyState = 1; bufferedAmount = 0; packets = 0;
    constructor() {
      metrics.modelConnections++; report(); queueMicrotask(() => this.onopen?.());
    }
    message(data) { this.onmessage?.({data:JSON.stringify(data)}); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.setup) queueMicrotask(() => this.message({setupComplete:{}}));
      if (message.realtimeInput?.audio) {
        this.packets++; metrics.audioPackets++; report();
        if(this.packets===4) this.message({serverContent:{interimInputTranscription:{text:'下周二去庆生',languageCode:'cmn-Hans-CN'}}});
        if(this.packets===9) this.message({serverContent:{inputTranscription:{text:'下周二去庆生。',languageCode:'cmn-Hans-CN'}}});
      }
    }
    close() { this.readyState=3; this.onclose?.({code:1000,reason:''}); }
  }
  window.WebSocket = TestSocket;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (url, options) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return originalFetch(url, options);
    metrics.translationRequests++; report();
    const result = {sourceLanguage:'zh',original:'下週二去青森。',translation:'来週火曜日に青森へ行きます。',corrections:[]};
    const event = {candidates:[{content:{parts:[{text:JSON.stringify(result)}]},finishReason:'STOP'}],
      usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}};
    return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  document.addEventListener('DOMContentLoaded',report);
})();
