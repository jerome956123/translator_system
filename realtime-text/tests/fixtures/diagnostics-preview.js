// Local UI fixture only. It is never imported by the production app.
(() => {
  const metrics = { microphoneRequests: 0, modelConnections: 0, translationRequests: 0, reviewRequests: 0, audioPackets: 0,
    silencePackets: 0, quietPackets: 0, reviewWavBytes: [], activityStarts: 0, activityEnds: 0,
    audioOutsideActivity: 0, sentSeconds: 0, manualActivity: false };
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
    // Clear onset, then a long pause and deliberately much quieter speech-shaped signal.
    gain.gain.setValueAtTime(0, context.currentTime + 2);
    gain.gain.setValueAtTime(0.0004, context.currentTime + 9);
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
    readyState = 1; bufferedAmount = 0; packets = 0; turnPackets = 0; active = false;
    constructor() {
      metrics.modelConnections++; report(); queueMicrotask(() => this.onopen?.());
    }
    message(data) { this.onmessage?.({data:JSON.stringify(data)}); }
    send(raw) {
      const message = JSON.parse(raw);
      if (message.setup) {
        this.manual = Boolean(message.setup.realtimeInputConfig?.automaticActivityDetection?.disabled);
        metrics.manualActivity = this.manual; report();
        queueMicrotask(() => this.message({setupComplete:{}}));
      }
      if (message.realtimeInput?.activityStart) {
        this.active = true; this.turnPackets = 0; metrics.activityStarts++; report();
      }
      if (message.realtimeInput?.audio) {
        this.packets++; this.turnPackets++; metrics.audioPackets++;
        if (this.manual && !this.active) metrics.audioOutsideActivity++;
        const binary = atob(message.realtimeInput.audio.data);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        const samples = new Int16Array(bytes.buffer);
        metrics.sentSeconds += samples.length / 16000;
        const peak = samples.reduce((value, sample) => Math.max(value, Math.abs(sample)), 0);
        if (!peak) metrics.silencePackets++;
        else if (peak < 50) metrics.quietPackets++;
        if((this.manual ? this.turnPackets : this.packets)===4) this.message({serverContent:{interimInputTranscription:{text:this.manual?'第一個字也有保留':'下周二去庆生',languageCode:'cmn-Hans-CN'}}});
        if(!this.manual && this.packets===9) this.message({serverContent:{inputTranscription:{text:'下周二去庆生。',languageCode:'cmn-Hans-CN'}}});
        report();
      }
      if (message.realtimeInput?.activityEnd) {
        this.active = false; metrics.activityEnds++; report();
        queueMicrotask(() => this.message({serverContent:{inputTranscription:{
          text:metrics.activityEnds===1?'第一個字也有保留。':'第二句也完整。',languageCode:'cmn-Hans-CN'},turnComplete:true}}));
      }
    }
    close() { this.readyState=3; this.onclose?.({code:1000,reason:''}); }
  }
  window.WebSocket = TestSocket;
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (url, options) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return originalFetch(url, options);
    if (String(url).endsWith(':generateContent')) {
      metrics.reviewRequests++;
      const body = JSON.parse(options.body);
      const data = body.contents[0].parts.find(part => part.inlineData).inlineData.data;
      metrics.reviewWavBytes.push(atob(data).length); report();
      const segments = metrics.reviewRequests === 1 ? [
        {sourceLanguage:'zh',original:'下周二去青森。停顿后这一句也有收进来。',translation:'来週火曜日に青森へ行きます。間を置いた後のこの一文も録音されています。'},
        {sourceLanguage:'ja',original:'声が小さくても聞こえますか。',translation:'声音小一点也听得到吗？'},
      ] : [];
      return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments})}]},finishReason:'STOP'}],
        usageMetadata:{promptTokenCount:816,candidatesTokenCount:90,promptTokensDetails:[{modality:'AUDIO',tokenCount:416},{modality:'TEXT',tokenCount:400}]}}),
        {headers:{'Content-Type':'application/json'}});
    }
    metrics.translationRequests++; report();
    const prompt = JSON.parse(options.body).contents[0].parts[0].text;
    const current = JSON.parse(prompt.split('DATA: ').at(-1)).current;
    const result = {sourceLanguage:'zh',original:metrics.manualActivity?current:'下週二去青森。',
      translation:metrics.manualActivity?'最初の文字も含めて翻訳しています。':'来週火曜日に青森へ行きます。',corrections:[]};
    const event = {candidates:[{content:{parts:[{text:JSON.stringify(result)}]},finishReason:'STOP'}],
      usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}};
    return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  document.addEventListener('DOMContentLoaded',report);
})();
