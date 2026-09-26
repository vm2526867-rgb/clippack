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

  /* ----- frames ----- */
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
  function toBlob(c,maxW){
    var s=Math.min(1,maxW/c.width), o=document.createElement("canvas");
    o.width=Math.round(c.width*s); o.height=Math.round(c.height*s);
    o.getContext("2d").drawImage(c,0,0,o.width,o.height);
    return new Promise(function(r){ o.toBlob(r,"image/jpeg",0.8); });
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
      n>0?("The attached images are "+n+" frames of the video in time order (video length about "+Math.round(dur)+" seconds)."):"No video frames are attached; use only the creator's note.",
      "Creator's own note (may be empty): \""+(note||"").slice(0,500)+"\"",
      "Output language for every text field: "+LANG[langSel.value],
      "",
      "Base everything only on what is visible in the frames and the note. If something is unclear, stay general. Never invent names, places, prices, statistics or claims. No misleading clickbait.",
      "",
      "Fill every field below:",
      "- score: a whole number 0 to 100 rating how ready this clip looks to publish as-is (hook strength, visual clarity, pacing you can infer from the frames). 100 is not achievable from 4 frames alone, so keep it realistic, mid-range unless it clearly stands out.",
      "- score_reason: one short line explaining the score in plain language.",
      "- category: 1 to 3 words naming the content niche (for example \"Home Cooking\" or \"Fitness\").",
      "- hooks: 5 short, distinct opening lines (spoken or on-screen text) a creator could use in the first 2 seconds to stop the scroll. Not the same as the titles below.",
      "- platforms: an object with exactly these 4 keys, each holding {title, description, hashtags}, all in the output language:",
      "  - ytshorts: "+PLATFORM_SPEC.ytshorts,
      "  - ytlong: "+PLATFORM_SPEC.ytlong,
      "  - reels: "+PLATFORM_SPEC.reels,
      "  - fb: "+PLATFORM_SPEC.fb,
      "  Every hashtags array uses real # symbols, no spaces inside a tag. Every description is 2 to 4 short lines with no hashtags inside it.",
      "- tags: 10 to 15 plain YouTube search keywords or phrases, no # symbol.",
      "- thumbnail_text: 2 to 4 words, at most 22 characters, punchy, in the output language, for overlay text on the thumbnail image.",
      "- thumbnail_emoji: one single emoji fitting the video's mood, for a decorative thumbnail badge.",
      "- thumbnail_visual_idea: one or two sentences describing an ideal thumbnail shot for this video (framing, expression, what should be visible), for a creator who wants to reshoot or design a custom thumbnail.",
      "- best_frame: the number (1 to "+Math.max(n,1)+") of the attached frame that makes the best thumbnail (sharp, clear subject); 0 if there are no frames.",
      "- best_time: one short line with a practical day/time window to post this for an Indian audience, and a one-phrase reason.",
      "- risk_note: one short, hedged line on whether this clip looks like original footage or looks like a repost/widely reused trend/audio, based only on what the frames suggest. Always make clear this is a rough guess from a few frames, never a certain or legal claim. If nothing stands out, say so plainly.",
      "- improvements: 3 to 5 short, concrete, actionable suggestions to make this specific clip perform better before posting.",
      "- comment_replies: 3 short, friendly reply templates a creator can paste when replying to viewer comments on this video. Generic enough to reuse, not tied to one specific comment.",
      "- summary: one short line saying what you understood the video is about, so the creator can check it.",
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
    not_configured:"The server isn't set up yet: add GEMINI_API_KEY in your Cloudflare project settings.",
    upstream_config:"The AI service rejected the request. Check your API key and the GEMINI_MODEL name.",
    upstream:"The AI service didn't respond. Try again in a moment.",
    invalid_json:"The AI's answer came back in the wrong format. Tap generate again.",
    refused:"The AI couldn't answer this input. Try another video or line.",
    bad_request:"Something was missing. Add a video or a longer line and try again.",
    bad_image:"The video frames were rejected. Try another video, or write one line instead.",
    forbidden:"This request was blocked. Open the site from its own address.",
    network:"Couldn't reach the server. Check your internet and try again."
  };
  async function callApi(prompt,images,signal){
    var res;
    try{
      res=await fetch("/api/generate",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:prompt,images:images}),signal:signal});
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
      var images=[], dur=0, note=hint.value.trim();
      if(file){
        setStatus("Extracting frames from your video...");
        var r=null;
        try{ r=await extractFrames(file,4); }catch(e){ r=null; }
        if(r){
          frames=r.frames; dur=r.duration;
          var blobs=await Promise.all(frames.map(function(f){ return toBlob(f,640); }));
          images=await Promise.all(blobs.map(blobToImage));
        } else if(note.length<10){
          setStatus("This video couldn't be opened in the browser (format). Try another video, or write one line and generate without a video.","err");
          return;
        }
      }
      timer=setInterval(function(){ setStatus("AI is thinking... "+Math.round((Date.now()-t0)/1000)+" sec"); },1000);
      setStatus("AI is thinking...");
      var out=await callApi(buildPrompt(images.length,dur,note),images,ctl.signal);
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
      data.riskNote=str(out.risk_note)||"Not enough to judge from the frames alone.";
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
        b.setAttribute("aria-label","Use frame "+(i+1)+" for the thumbnail");
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
    data.improvements.forEach(function(s){ var li=document.createElement("li"); li.textContent=s; ol.appendChild(li); });

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
  Array.prototype.forEach.call(document.querySelectorAll("[data-copy]"),function(b){
    b.addEventListener("click",function(){
      var k=b.getAttribute("data-copy"), t="";
      if(k==="tags") t=data.tags.join(", ");
      copyText(t,b);
    });
  });

  /* ----- thumbnail ----- */
  function wrapLines(ctx,text,maxW){
    var words=text.split(/\s+/).filter(Boolean), lines=[], cur="";
    words.forEach(function(w){
      var test=cur?cur+" "+w:w;
      if(ctx.measureText(test).width<=maxW||!cur) cur=test; else { lines.push(cur); cur=w; }
    });
    if(cur) lines.push(cur);
    return lines;
  }
  function fitLines(ctx,text,maxW,maxSize,minSize,maxLines,weight,font){
    var size=maxSize, lines=[];
    for(;size>=minSize;size-=4){
      ctx.font=weight+' '+size+'px "'+font+'","Hind",system-ui,sans-serif';
      lines=wrapLines(ctx,text,maxW);
      var okw=lines.every(function(l){ return ctx.measureText(l).width<=maxW; });
      if(lines.length<=maxLines&&okw) break;
    }
    return {size:size,lines:lines};
  }
  async function drawThumb(){
    try{ await document.fonts.load('800 60px "Archivo"'); await document.fonts.load('700 60px "Archivo"',"\u0905\u0906"); }catch(e){}
    var wide=platformSel.value==="ytlong", W=wide?1280:1080, H=wide?720:1920;
    canvas.width=W; canvas.height=H;
    var ctx=canvas.getContext("2d"), src=(thumbStyle==="ai"&&aiImg)?aiImg:frames[bestIdx];
    if(src){
      var s=Math.max(W/src.width,H/src.height), dw=src.width*s, dh=src.height*s;
      ctx.drawImage(src,(W-dw)/2,(H-dh)/2,dw,dh);
    } else {
      var g=ctx.createLinearGradient(0,0,W,H);
      g.addColorStop(0,"#E7A23C"); g.addColorStop(0.55,"#C97435"); g.addColorStop(1,"#7A2E1C");
      ctx.fillStyle=g; ctx.fillRect(0,0,W,H);
    }
    var text=thumbText.value.trim();

    if(thumbStyle==="minimal"){
      var barH=H*0.2;
      ctx.fillStyle="#1B130A"; ctx.fillRect(0,H-barH,W,barH);
      ctx.fillStyle="#E7A23C"; ctx.fillRect(0,H-barH,W*0.05,barH);
      if(!text) return;
      var fit=fitLines(ctx,text,W*0.82,W*0.09,W*0.04,2,"700","Archivo");
      ctx.textAlign="left"; ctx.textBaseline="middle"; ctx.fillStyle="#fff";
      ctx.font='700 '+fit.size+'px "Archivo",system-ui,sans-serif';
      var lh1=fit.size*1.18, y0=H-barH/2-((fit.lines.length-1)*lh1)/2;
      fit.lines.forEach(function(l,i){ ctx.fillText(l,W*0.08,y0+i*lh1); });
      return;
    }

    var sc=ctx.createLinearGradient(0,H*0.45,0,H);
    sc.addColorStop(0,"rgba(0,0,0,0)"); sc.addColorStop(1,"rgba(0,0,0,0.75)");
    ctx.fillStyle=sc; ctx.fillRect(0,H*0.45,W,H*0.55);

    if(thumbStyle==="emoji"){
      var er=W*0.09, ex=W*0.14, ey=H*0.14;
      ctx.beginPath(); ctx.arc(ex,ey,er,0,Math.PI*2); ctx.fillStyle="rgba(0,0,0,.45)"; ctx.fill();
      ctx.strokeStyle="rgba(255,255,255,.7)"; ctx.lineWidth=W*0.004; ctx.stroke();
      ctx.font=(er*1.15)+'px system-ui,"Segoe UI Emoji","Noto Color Emoji",sans-serif';
      ctx.textAlign="center"; ctx.textBaseline="middle";
      ctx.fillStyle="#fff"; ctx.fillText(data.thumbEmoji||"\u2728",ex,ey+er*0.06);
    }

    if(!text) return;
    var f2=fitLines(ctx,text,W*0.86,W*0.15,W*0.05,3,"800","Archivo");
    ctx.textAlign="center"; ctx.textBaseline="alphabetic"; ctx.lineJoin="round";
    ctx.lineWidth=f2.size*0.16; ctx.strokeStyle="#000"; ctx.fillStyle="#fff";
    ctx.font='800 '+f2.size+'px "Archivo",system-ui,sans-serif';
    var lh=f2.size*1.12, y=H-H*0.07-(f2.lines.length-1)*lh;
    f2.lines.forEach(function(l,i){ var yy=y+i*lh; ctx.strokeText(l,W/2,yy); ctx.fillText(l,W/2,yy); });
  }
  thumbText.addEventListener("input",function(){ drawThumb(); });

  var stylebar=$("stylebar");
  function selectStyle(name){
    thumbStyle=name;
    Array.prototype.forEach.call(stylebar.querySelectorAll(".stylechip"),function(x){ x.setAttribute("aria-pressed",x.getAttribute("data-style")===name?"true":"false"); });
    drawThumb();
  }
  if(stylebar){
    Array.prototype.forEach.call(stylebar.querySelectorAll(".stylechip"),function(b){
      b.addEventListener("click",function(){ selectStyle(b.getAttribute("data-style")); });
    });
  }

  function loadImage(dataUrl){
    return new Promise(function(res,rej){
      var img=new Image();
      img.onload=function(){ res(img); };
      img.onerror=function(){ rej(new Error("decode")); };
      img.src=dataUrl;
    });
  }
  var THUMB_ERR={
    ai_not_configured:"AI photos aren't turned on for this site yet: add a Workers AI binding named AI in Cloudflare project settings.",
    bad_request:"Add a one-line description above (or a video) first, then try again.",
    rate_limited:"The free daily limit for AI photos is reached. Try again tomorrow.",
    upstream:"The AI photo service didn't respond. Try again in a moment.",
    invalid_json:"Couldn't create a photo from that. Try a different description.",
    forbidden:"This request was blocked. Open the site from its own address.",
    network:"Couldn't reach the server. Check your internet and try again."
  };
  if(genThumb){
    genThumb.addEventListener("click",async function(){
      if(aiCtl) aiCtl.abort();
      aiCtl=new AbortController();
      genThumb.disabled=true; thumbAiStatus.className="note"; thumbAiStatus.textContent="Creating a photo... this can take a few seconds.";
      try{
        var scene=(hint.value.trim()||data.titles[0]||"a short video for social media").slice(0,300);
        var res=await fetch("/api/thumbnail",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:scene}),signal:aiCtl.signal});
        var j=null; try{ j=await res.json(); }catch(e){}
        if(!res.ok||!j||!j.image) throw {code:(j&&j.error)||("http_"+res.status)};
        aiImg=await loadImage("data:image/jpeg;base64,"+j.image);
        aiChip.hidden=false;
        selectStyle("ai");
        thumbAiStatus.textContent="Done. This used a small amount of the site's free daily AI photo allowance.";
      }catch(e){
        if(e&&e.name==="AbortError") return;
        thumbAiStatus.className="note err";
        thumbAiStatus.textContent=THUMB_ERR[e&&e.code]||"Something went wrong. Please try again.";
      } finally {
        genThumb.disabled=false;
      }
    });
  }

  var tb=$("tiltbox"), tw=$("tiltwrap");
  if(!reduce&&window.matchMedia&&window.matchMedia("(pointer:fine)").matches){
    tb.addEventListener("pointermove",function(e){
      var r=tb.getBoundingClientRect(), x=(e.clientX-r.left)/r.width-0.5, y=(e.clientY-r.top)/r.height-0.5;
      tw.style.setProperty("--ry",(x*14)+"deg"); tw.style.setProperty("--rx",(-y*10)+"deg");
    });
    tb.addEventListener("pointerleave",function(){ tw.style.setProperty("--ry","0deg"); tw.style.setProperty("--rx","0deg"); });
  }

  dl.addEventListener("click",async function(){
    dlmsg.textContent="";
    var blob=await new Promise(function(r){ canvas.toBlob(r,"image/png"); });
    if(!blob){ dlmsg.textContent="Couldn't create the image. Long-press the thumbnail to save it."; return; }
    var url=URL.createObjectURL(blob), a=document.createElement("a");
    a.href=url; a.download="clippack-thumbnail.png"; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(url); },4000);
    dlmsg.textContent="Download started. If nothing happens, long-press the thumbnail to save it.";
  });
})();
