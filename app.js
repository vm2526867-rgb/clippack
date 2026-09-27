/* ============ ClipPack tool ============ */
(function(){
  "use strict";
  var $=function(id){ return document.getElementById(id); };
  var fileInput=$("file"), drop=$("drop"), dropTitle=$("dropTitle"), dropSub=$("dropSub");
  var platformSel=$("platform"), langSel=$("lang"), hint=$("hint");
  var go=$("go"), stopBtn=$("stop"), statusEl=$("status"), bar=$("bar");
  var stripWrap=$("stripWrap"), strip=$("strip"), results=$("results");
  var canvas=$("thumb"), thumbText=$("thumbText"), dl=$("dl"), dlmsg=$("dlmsg");
  var genThumb=$("genThumb"), thumbAiStatus=$("thumbAiStatus"), aiChip=$("aiChip");
  var scoreNum=$("scoreNum"), scoreFill=$("scoreFill"), scoreReasonEl=$("scoreReason"), categoryEl=$("category");
  var hooksEl=$("hooks"), ptabs=$("ptabs"), pTitleEl=$("pTitle"), pDescriptionEl=$("pDescription"), pHashtagsEl=$("pHashtags"), copyAllBtn=$("copyAll");
  var thumbIdeaEl=$("thumbIdea"), riskNoteEl=$("riskNote"), improvementsEl=$("improvements");
  var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var file=null, frames=[], bestIdx=0, ctl=null, thumbStyle="bold", aiImg=null, aiCtl=null, generated=false;
  var PLATFORMS=["ytshorts","ytlong","reels","fb"];
  function emptyPlatforms(){
    var o={}; PLATFORMS.forEach(function(k){ o[k]={title:"",description:"",hashtags:[]}; }); return o;
  }
  var data={
    score:0, scoreReason:"", category:"", hooks:[],
    platforms:emptyPlatforms(), activePlatform:"ytshorts",
    tags:[], thumbIdea:"", bestTime:"", riskNote:"", improvements:[], replies:[],
    thumbEmoji:"\u2728"
  };

  try{
    var p=localStorage.getItem("cp_platform"), l=localStorage.getItem("cp_lang");
    if(p) platformSel.value=p; if(l) langSel.value=l;
  }catch(e){}
  platformSel.addEventListener("change",function(){
    try{localStorage.setItem("cp_platform",platformSel.value);}catch(e){}
    if(generated){ data.activePlatform=platformSel.value; renderPlatform(); drawThumb(); }
  });
  langSel.addEventListener("change",function(){ try{localStorage.setItem("cp_lang",langSel.value);}catch(e){} });

  function setStatus(msg,kind){ statusEl.textContent=msg||""; statusEl.className=kind||""; }
  function refreshGo(){
    var hasInput=!!file||hint.value.trim().length>=10;
    go.disabled=!hasInput;
    go.textContent=hasInput?"Generate title and hashtags":"Choose a video or write a line";
  }
  fileInput.addEventListener("change",function(){
    file=(fileInput.files&&fileInput.files[0])||null;
    if(file){
      drop.classList.add("has"); dropTitle.textContent=file.name;
      dropSub.textContent=(file.size/1048576).toFixed(1)+" MB. Tap here to choose a different video.";
    } else { drop.classList.remove("has"); dropTitle.textContent="Choose a video"; }
    refreshGo();
  });
  hint.addEventListener("input",refreshGo);
  refreshGo();

  /* ----- frames & audio ----- */
  function loadVideo(f){
    return new Promise(function(res,rej){
      var url=URL.createObjectURL(f), v=document.createElement("video");
      v.muted=true; v.playsInline=true; v.preload="auto"; v.src=url;
      var t=setTimeout(function(){ URL.revokeObjectURL(url); rej(new Error("timeout")); },20000);
      v.onloadeddata=function(){ clearTimeout(t); res({v:v,url:url}); };
      v.onerror=function(){ clearTimeout(t); URL.revokeObjectURL(url); rej(new Error("decode")); };
    });
  }
  function seek(v,time){
    return new Promise(function(res){
      var done=false;
      function fin(){ if(done) return; done=true; v.removeEventListener("seeked",fin); res(); }
      v.addEventListener("seeked",fin); v.currentTime=time; setTimeout(fin,4000);
    });
  }
  async function extractFrames(f,count){
    var lv=await loadVideo(f), v=lv.v;
    try{
      var w0=v.videoWidth,h0=v.videoHeight;
      if(!w0||!h0) throw new Error("decode");
      var dur=(isFinite(v.duration)&&v.duration>0)?v.duration:1, sc=Math.min(1,1280/w0), out=[];
      for(var i=0;i<count;i++){
        await seek(v,Math.max(0,Math.min(dur-0.05,dur*(i+0.5)/count)));
        var c=document.createElement("canvas"); c.width=Math.round(w0*sc); c.height=Math.round(h0*sc);
        c.getContext("2d").drawImage(v,0,0,c.width,c.height); out.push(c);
      }
      return {frames:out,duration:dur};
    } finally { URL.revokeObjectURL(lv.url); }
  }

  // AUDIO EXTRACTION: Browser me WebAudio se video ka audio decode karna
  async function extractAudio(file) {
    try {
      var arrayBuffer = await file.arrayBuffer();
      var audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      var audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      
      var offlineCtx = new OfflineAudioContext(1, audioBuffer.sampleRate * Math.min(audioBuffer.duration, 45), 16000);
      var source = offlineCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      
      var renderedBuffer = await offlineCtx.startRendering();
      var pcmData = renderedBuffer.getChannelData(0);
      
      // Convert to WAV
      var wavBuffer = createWavBuffer(pcmData, 16000);
      var binary = "";
      var bytes = new Uint8Array(wavBuffer);
      var len = bytes.byteLength;
      for (var i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
      }
      return { mime: "audio/wav", data: window.btoa(binary) };
    } catch (e) {
      console.warn("Audio extraction skipped/failed:", e);
      return null;
    }
  }

  function createWavBuffer(samples, sampleRate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function writeString(offset, string) {
      for (var i = 0; i < string.length; i++) { view.setUint8(offset + i, string.charCodeAt(i)); }
    }
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);
    var offset = 44;
    for (var i = 0; i < samples.length; i++, offset += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  function toBlob(c,maxW){
    var s=Math.min(1,maxW/c.width), o=document.createElement("canvas");
    o.width=Math.round(c.width*s); o.height=Math.round(c.height*s);
    o.getContext("2d").drawImage(c,0,0,o.width,o.height);
    return new Promise(function(r){ o.toBlob(r,"image/jpeg",0.7); });
  }
  function blobToImage(b){
    return new Promise(function(res,rej){
      var fr=new FileReader();
      fr.onload=function(){ var s=String(fr.result); res({mime:"image/jpeg",data:s.slice(s.indexOf(",")+1)}); };
      fr.onerror=function(){ rej(new Error("read")); };
      fr.readAsDataURL(b);
    });
  }

  /* ----- prompt ----- */
  var PLATFORM_SPEC={
    ytshorts:"YouTube Shorts: vertical, under 60 seconds. Title max 70 characters. Include #Shorts among its hashtags. 6 to 10 hashtags.",
    ytlong:"YouTube long-form video: title max 70 characters, description can run 3 to 5 short lines. 6 to 10 hashtags.",
    reels:"Instagram Reels: the title doubles as the first line of the caption, max 90 characters. 6 to 8 hashtags.",
    fb:"Facebook video: friendly, conversational caption, title max 100 characters. 4 to 6 hashtags."
  };
  var LANG={
    hinglish:"Hinglish: Hindi written in Roman script, mixed with English words the way Indian creators write.",
    hindi:"Hindi in Devanagari script.",
    english:"Simple, natural English."
  };
  function buildPrompt(n,dur,note){
    return [
      "You are an assistant that helps an Indian short-video creator get one clip ready to publish.",
      "LISTEN CAREFULLY to the attached spoken audio track to understand exactly what is being said, the main topic, names, places, and context.",
      n>0?("The attached images are "+n+" visual frames of the video in time order."):"No video frames are attached.",
      "Creator's own note (may be empty): \""+(note||"").slice(0,500)+"\"",
      "Output language for every text field: "+LANG[langSel.value],
      "Fill every field below:",
      "- score: a whole number 0 to 100 rating how ready this clip looks to publish as-is.",
      "- score_reason: one short line explaining the score in plain language.",
      "- category: 1 to 3 words naming the content niche.",
      "- hooks: 5 short, distinct opening lines a creator could use in the first 2 seconds.",
      "- platforms: an object with exactly these 4 keys, each holding {title, description, hashtags}, all in the output language:",
      "  - ytshorts: "+PLATFORM_SPEC.ytshorts,
      "  - ytlong: "+PLATFORM_SPEC.ytlong,
      "  - reels: "+PLATFORM_SPEC.reels,
      "  - fb: "+PLATFORM_SPEC.fb,
      "- tags: 10 to 15 plain YouTube search keywords or phrases.",
      "- thumbnail_text: 2 to 4 words punchy overlay text.",
      "- thumbnail_emoji: one single emoji.",
      "- thumbnail_visual_idea: one or two sentences describing an ideal thumbnail shot.",
      "- best_frame: the number (1 to "+Math.max(n,1)+") of the frame that makes the best thumbnail.",
      "- best_time: practical window to post for an Indian audience.",
      "- risk_note: short line on whether this clip looks original or reused.",
      "- improvements: 3 to 5 actionable suggestions.",
      "- comment_replies: 3 friendly reply templates.",
      "- summary: one short line summarizing the spoken audio & video.",
      "",
      "Reply with ONLY this JSON, matching every key exactly:",
      "{\"summary\":\"\",\"score\":0,\"score_reason\":\"\",\"category\":\"\",\"hooks\":[\"\",\"\",\"\",\"\",\"\"],",
      "\"platforms\":{\"ytshorts\":{\"title\":\"\",\"description\":\"\",\"hashtags\":[\"#\"]},\"ytlong\":{\"title\":\"\",\"description\":\"\",\"hashtags\":[\"#\"]},\"reels\":{\"title\":\"\",\"description\":\"\",\"hashtags\":[\"#\"]},\"fb\":{\"title\":\"\",\"description\":\"\",\"hashtags\":[\"#\"]}},",
      "\"tags\":[\"\"],\"thumbnail_text\":\"\",\"thumbnail_emoji\":\"\",\"thumbnail_visual_idea\":\"\",\"best_frame\":1,\"best_time\":\"\",\"risk_note\":\"\",\"improvements\":[\"\",\"\",\"\"],\"comment_replies\":[\"\",\"\",\"\"]}"
    ].join("\n");
  }

  /* ----- server call ----- */
  var ERR={
    rate_limited:"The free AI limit is reached for now. Wait a minute and try again.",
    not_configured:"The server isn't set up yet: add GEMINI_API_KEY in Cloudflare settings.",
    upstream_config:"The AI service rejected the request. Check API key and GEMINI_MODEL.",
    upstream:"The AI service didn't respond. Try again in a moment.",
    invalid_json:"The AI answer came in wrong format. Tap generate again.",
    refused:"The AI couldn't answer this input. Try another video.",
    bad_request:"Something was missing. Add a video and try again.",
    forbidden:"Request blocked. Open site from its own address.",
    network:"Couldn't reach server. Check internet and try again."
  };

  async function callApi(prompt, images, audio, signal){
    var res;
    try{
      res=await fetch("/api/generate",{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({prompt:prompt, images:images, audio:audio}),
        signal:signal
      });
    }catch(e){
      if(e&&e.name==="AbortError") throw {code:"cancelled"};
      throw {code:"network"};
    }
    var j=null; try{ j=await res.json(); }catch(e){}
    if(!res.ok||!j||!j.result) throw {code:(j&&j.error)||("http_"+res.status)};
    return j.result;
  }

  function arr(x){ return Array.isArray(x)?x:[]; }
  function str(x){ return typeof x==="string"?x.trim():""; }
  function busy(b){ bar.classList.toggle("on",b); if(window.ClipStage) window.ClipStage.setBusy(b); }

  go.addEventListener("click",async function(){
    if(go.disabled) return;
    ctl=new AbortController();
    go.disabled=true; stopBtn.hidden=false; busy(true);
    results.hidden=true; results.classList.remove("show"); stripWrap.hidden=true;
    frames=[]; bestIdx=0; dlmsg.textContent=""; generated=false;
    if(aiCtl) aiCtl.abort();
    aiImg=null; if(aiChip){ aiChip.hidden=true; } if(thumbAiStatus){ thumbAiStatus.textContent=""; }
    selectStyle("bold");
    var t0=Date.now(), timer=null;
    try{
      var images=[], audio=null, dur=0, note=hint.value.trim();
      if(file){
        setStatus("Extracting audio & video frames...");
        
        // Extract both Frames and Audio simultaneously
        var rExt = await extractFrames(file, 3);
        if(rExt){
          frames = rExt.frames;
          dur = rExt.duration;
          var blobs = await Promise.all(frames.map(function(f){ return toBlob(f, 480); }));
          images = await Promise.all(blobs.map(blobToImage));
        }

        setStatus("Extracting speech/audio track...");
        audio = await extractAudio(file);
      }

      timer=setInterval(function(){ setStatus("AI is analyzing speech & video... "+Math.round((Date.now()-t0)/1000)+" sec"); },1000);
      setStatus("AI is analyzing speech & video...");
      
      var out=await callApi(buildPrompt(images.length, dur, note), images, audio, ctl.signal);
      var pin=out.platforms&&typeof out.platforms==="object"?out.platforms:{};
      var anyTitle=PLATFORMS.some(function(k){ return pin[k]&&str(pin[k].title); });
      if(!anyTitle) throw {code:"invalid_json"};
      var platforms=emptyPlatforms();
      PLATFORMS.forEach(function(k){
        var p=pin[k]||{};
        platforms[k]={
          title:str(p.title),
          description:str(p.description),
          hashtags:arr(p.hashtags).map(str).filter(Boolean).map(function(h){ h=h.replace(/\s+/g,""); return h.charAt(0)==="#"?h:"#"+h; }).slice(0,14)
        };
      });
      data.platforms=platforms;
      data.activePlatform=PLATFORMS.indexOf(platformSel.value)>=0?platformSel.value:"ytshorts";
      var sc=parseInt(out.score,10);
      data.score=isFinite(sc)?Math.max(0,Math.min(100,sc)):0;
      data.scoreReason=str(out.score_reason);
      data.category=str(out.category)||"General";
      data.hooks=arr(out.hooks).map(str).filter(Boolean).slice(0,5);
      data.tags=arr(out.tags).map(str).filter(Boolean).slice(0,16);
      data.thumbIdea=str(out.thumbnail_visual_idea);
      data.riskNote=str(out.risk_note)||"Not enough to judge.";
      data.improvements=arr(out.improvements).map(str).filter(Boolean).slice(0,6);
      var bf=parseInt(out.best_frame,10);
      bestIdx=(frames.length&&bf>=1&&bf<=frames.length)?bf-1:0;
      $("summary").textContent=str(out.summary)?("What the AI understood: "+str(out.summary)):"";
      $("summary").hidden=!str(out.summary);
      thumbText.value=str(out.thumbnail_text).slice(0,30);
      data.thumbEmoji=Array.from(str(out.thumbnail_emoji))[0]||"\u2728";
      data.bestTime=str(out.best_time);
      data.replies=arr(out.comment_replies).map(str).filter(Boolean).slice(0,4);
      generated=true;
      await render();
      setStatus("Done. Everything is ready below.","ok");
      results.hidden=false;
      requestAnimationFrame(function(){ results.classList.add("show"); });
      results.scrollIntoView({behavior:reduce?"auto":"smooth",block:"start"});
    }catch(e){
      if(e&&e.code==="cancelled") setStatus("Stopped.");
      else setStatus(ERR[e&&e.code]||"Something went wrong. Please try again.","err");
    } finally {
      if(timer) clearInterval(timer);
      stopBtn.hidden=true; busy(false); refreshGo();
    }
  });
  stopBtn.addEventListener("click",function(){ if(ctl) ctl.abort(); });

  /* ----- render ----- */
  function copyText(text,btn){
    var label=btn.dataset.label||btn.textContent; btn.dataset.label=label;
    (async function(){
      var ok=false;
      try{ await navigator.clipboard.writeText(text); ok=true; }catch(e){}
      if(!ok){
        try{
          var ta=document.createElement("textarea"); ta.value=text; ta.style.cssText="position:fixed;opacity:0;top:0;left:0";
          document.body.appendChild(ta); ta.select(); ok=document.execCommand("copy"); ta.remove();
        }catch(e){}
      }
      btn.textContent=ok?"Copied":"Couldn't copy";
      setTimeout(function(){ btn.textContent=label; },1600);
    })();
  }
  function clear(el){ while(el.firstChild) el.removeChild(el.firstChild); }

  function renderPlatform(){
    var p=data.platforms[data.activePlatform]||{title:"",description:"",hashtags:[]};
    pTitleEl.textContent=p.title;
    pDescriptionEl.textContent=p.description;
    clear(pHashtagsEl);
    p.hashtags.forEach(function(h){ var li=document.createElement("li"); li.textContent=h; pHashtagsEl.appendChild(li); });
    Array.prototype.forEach.call(ptabs.querySelectorAll(".stylechip"),function(b){
      b.setAttribute("aria-pressed",b.getAttribute("data-p")===data.activePlatform?"true":"false");
    });
  }
  Array.prototype.forEach.call(ptabs.querySelectorAll(".stylechip"),function(b){
    b.addEventListener("click",function(){ data.activePlatform=b.getAttribute("data-p"); renderPlatform(); });
  });
  copyAllBtn.addEventListener("click",function(){
    var p=data.platforms[data.activePlatform]||{title:"",description:"",hashtags:[]};
    var text=[p.title,"",p.description,"",p.hashtags.join(" ")].join("\n");
    copyText(text,copyAllBtn);
  });

  async function render(){
    clear(strip);
    if(frames.length){
      frames.forEach(function(c,i){
        var b=document.createElement("button"); b.type="button"; b.className="frame";
        b.setAttribute("aria-label","Use frame "+(i+1)+" for thumbnail");
        b.setAttribute("aria-pressed",i===bestIdx?"true":"false");
        var img=document.createElement("img"); img.alt=""; img.src=c.toDataURL("image/jpeg",0.5); b.appendChild(img);
        var tag=document.createElement("span"); tag.className="tag"; tag.textContent="Thumbnail"; tag.hidden=i!==bestIdx; b.appendChild(tag);
        b.addEventListener("click",function(){
          bestIdx=i;
          Array.prototype.forEach.call(strip.children,function(x,j){
            x.setAttribute("aria-pressed",j===i?"true":"false"); x.querySelector(".tag").hidden=j!==i;
          });
          drawThumb();
        });
        strip.appendChild(b);
      });
      stripWrap.hidden=false;
    }

    scoreNum.textContent=String(data.score);
    scoreFill.style.width=data.score+"%";
    scoreReasonEl.textContent=data.scoreReason;
    categoryEl.textContent=data.category;

    clear(hooksEl);
    data.hooks.forEach(function(h){
      var li=document.createElement("li");
      var box=document.createElement("div"); box.className="t"; box.textContent=h;
      var b=document.createElement("button"); b.type="button"; b.className="ghost"; b.textContent="Copy";
      b.addEventListener("click",function(){ copyText(h,b); });
      li.appendChild(box); li.appendChild(b); hooksEl.appendChild(li);
    });

    renderPlatform();
    $("tags").textContent=data.tags.join(", ");
    thumbIdeaEl.textContent=data.thumbIdea||"Not available for this video.";
    $("besttime").textContent=data.bestTime||"Not available for this video.";
    riskNoteEl.textContent=data.riskNote;

    var ol=$("improvements"); clear(ol);
    data.improvements.forEach(function(s){ var li=document.textContent=s; ol.appendChild(li); });

    var rl=$("replies"); clear(rl);
    data.replies.forEach(function(r){
      var li=document.createElement("li");
      var box=document.createElement("div"); box.className="t"; box.textContent=r;
      var b=document.createElement("button"); b.type="button"; b.className="ghost"; b.textContent="Copy";
      b.addEventListener("click",function(){ copyText(r,b); });
      li.appendChild(box); li.appendChild(b); rl.appendChild(li);
    });
    await drawThumb();
  }

  Array.prototype.forEa
