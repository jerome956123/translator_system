// Local UI fixture only. It is never imported by the production app.
(() => {
  const metrics = { microphoneRequests: 0, modelConnections: 0, translationRequests: 0, reviewRequests: 0, audioPackets: 0,
    silencePackets: 0, quietPackets: 0, reviewWavBytes: [], activityStarts: 0, activityEnds: 0,
    audioOutsideActivity: 0, sentSeconds: 0, manualActivity: false, languageRepairs: 0,
    continuityRequests: 0 };
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
        if((this.manual ? this.turnPackets : this.packets)===4) this.message({serverContent:{interimInputTranscription:{text:this.manual?'来週は青森に行きます':'下周二去庆生',languageCode:'cmn-Hans-CN'}}});
        if(!this.manual && this.packets===9) this.message({serverContent:{inputTranscription:{text:'下周二去庆生。',languageCode:'cmn-Hans-CN'}}});
        report();
      }
      if (message.realtimeInput?.activityEnd) {
        this.active = false; metrics.activityEnds++; report();
        queueMicrotask(() => this.message({serverContent:{inputTranscription:{
          text:'来週は青森に行きます。',languageCode:'cmn-Hans-CN'},turnComplete:true}}));
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
      const prompt = body.contents[0].parts[0].text;
      if (prompt.includes('LANGUAGE REPAIR')) metrics.languageRepairs++;
      const prior = prompt.split('PREVIOUS RESULT (reference data only): ')[1]?.split('\n')[0];
      const previousSegments = prior ? JSON.parse(prior).map(segment => ({
        sourceLanguage: segment.direction.slice(0, 2), targetLanguage: segment.direction.slice(3),
        original: segment.original, translation: segment.original.includes('青森') ? '我沒有打算去青森' : segment.translation,
      })) : undefined;
      if (prior) metrics.continuityRequests++;
      const data = body.contents[0].parts.find(part => part.inlineData).inlineData.data;
      metrics.reviewWavBytes.push(atob(data).length); report();
      const segments = metrics.reviewRequests <= 2 ? [
        {sourceLanguage:'ja',targetLanguage:'zh',original:'青森に行くつもり',translation:metrics.reviewRequests===1?'青森に行くつもり':'我打算去青森'},
      ] : prior && metrics.continuityRequests === 1 ? [
        {sourceLanguage:'ja',targetLanguage:'zh',original:'はありません。弘前に行きます。',translation:'，而是要去弘前。'},
      ] : [];
      return new Response(JSON.stringify({candidates:[{content:{parts:[{text:JSON.stringify({segments,previousSegments})}]},finishReason:'STOP'}],
        usageMetadata:{promptTokenCount:816,candidatesTokenCount:90,promptTokensDetails:[{modality:'AUDIO',tokenCount:416},{modality:'TEXT',tokenCount:400}]}}),
        {headers:{'Content-Type':'application/json'}});
    }
    metrics.translationRequests++; report();
    const prompt = JSON.parse(options.body).contents[0].parts[0].text;
    const current = JSON.parse(prompt.split('\nDATA: ').at(-1).split('\nLANGUAGE REPAIR:')[0]).current;
    if (prompt.includes('LANGUAGE REPAIR')) metrics.languageRepairs++;
    const result = metrics.manualActivity ? {sourceLanguage:'ja',targetLanguage:'zh',original:current,
      translation:metrics.translationRequests===1?'来週は青森に行きます。':'下週要去青森。',corrections:[]}
      : {sourceLanguage:'zh',targetLanguage:'ja',original:'下週二去青森。',translation:'来週火曜日に青森へ行きます。',corrections:[]};
    report();
    const event = {candidates:[{content:{parts:[{text:JSON.stringify(result)}]},finishReason:'STOP'}],
      usageMetadata:{promptTokenCount:100,candidatesTokenCount:20}};
    return new Response('data: '+JSON.stringify(event)+'\n\n',{headers:{'Content-Type':'text/event-stream'}});
  };
  document.addEventListener('DOMContentLoaded',report);
})();
