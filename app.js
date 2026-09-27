/* ============ ClipPack tool V2 ============ */
(function(){
  "use strict";

  var $=function(id){ return document.getElementById(id); };

  var fileInput=$("file"),
      drop=$("drop"),
      dropTitle=$("dropTitle"),
      dropSub=$("dropSub"),
      platformSel=$("platform"),
      langSel=$("lang"),
      hint=$("hint"),
      go=$("go"),
      stopBtn=$("stop"),
      statusEl=$("status"),
      bar=$("bar"),
      stripWrap=$("stripWrap"),
      strip=$("strip"),
      results=$("results");

  var canvas=$("thumb"),
      thumbText=$("thumbText"),
      dl=$("dl"),
      dlmsg=$("dlmsg"),
      genThumb=$("genThumb"),
      thumbAiStatus=$("thumbAiStatus"),
      aiChip=$("aiChip");

  var scoreNum=$("scoreNum"),
      scoreFill=$("scoreFill"),
      scoreReasonEl=$("scoreReason"),
      categoryEl=$("category");

  var hooksEl=$("hooks"),
      ptabs=$("ptabs"),
      pTitleEl=$("pTitle"),
      pDescriptionEl=$("pDescription"),
      pHashtagsEl=$("pHashtags"),
      copyAllBtn=$("copyAll");

  var thumbIdeaEl=$("thumbIdea"),
      riskNoteEl=$("riskNote"),
      improvementsEl=$("improvements");

  var reduce=window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var file=null,
      frames=[],
      bestIdx=0,
      ctl=null,
      thumbStyle="bold",
      aiImg=null,
      aiCtl=null,
      generated=false;

  var PLATFORMS=["ytshorts","ytlong","reels","fb"];

  function emptyPlatforms(){
    var o={};
    PLATFORMS.forEach(function(k){
      o[k]={
        title:"",
        description:"",
        hashtags:[]
      };
    });
    return o;
  }

  var data={
    score:0,
    scoreReason:"",
    category:"",
    hooks:[],
    platforms:emptyPlatforms(),
    activePlatform:"ytshorts",
    tags:[],
    thumbIdea:"",
    bestTime:"",
    riskNote:"",
    improvements:[],
    replies:[],
    thumbEmoji:"✨"
  };

  try{
    var p=localStorage.getItem("cp_platform");
    var l=localStorage.getItem("cp_lang");

    if(p) platformSel.value=p;
    if(l) langSel.value=l;
  }catch(e){}

  if(platformSel){
    platformSel.addEventListener("change",function(){
      try{
        localStorage.setItem("cp_platform",platformSel.value);
      }catch(e){}

      if(generated){
        data.activePlatform=platformSel.value;
        renderPlatform();
        drawThumb();
      }
    });
  }

  if(langSel){
    langSel.addEventListener("change",function(){
      try{
        localStorage.setItem("cp_lang",langSel.value);
      }catch(e){}
    });
  }

  function setStatus(msg,kind){
    if(!statusEl) return;
    statusEl.textContent=msg||"";
    statusEl.className=kind||"";
  }

  function refreshGo(){
    if(!go) return;

    var hasInput=
      !!file ||
      (hint && hint.value.trim().length>=10);

    go.disabled=!hasInput;

    go.textContent=hasInput
      ?"Generate title and hashtags"
      :"Choose a video or write a line";
  }

  if(fileInput){
    fileInput.addEventListener("change",function(){
      file=(fileInput.files&&fileInput.files[0])||null;

      if(file){
        if(drop) drop.classList.add("has");

        if(dropTitle)
          dropTitle.textContent=file.name;

        if(dropSub){
          dropSub.textContent=
            (file.size/1048576).toFixed(1)+
            " MB. Tap here to choose a different video.";
        }
      }else{
        if(drop) drop.classList.remove("has");
        if(dropTitle) dropTitle.textContent="Choose a video";
      }

      refreshGo();
    });
  }

  if(hint){
    hint.addEventListener("input",refreshGo);
  }

  refreshGo();


  /* =========================================================
     VIDEO FRAME EXTRACTION
     ========================================================= */

  function loadVideo(f){
    return new Promise(function(res,rej){

      var url=URL.createObjectURL(f);
      var v=document.createElement("video");

      v.muted=true;
      v.playsInline=true;
      v.preload="auto";
      v.src=url;

      var t=setTimeout(function(){
        URL.revokeObjectURL(url);
        rej(new Error("timeout"));
      },20000);

      v.onloadeddata=function(){
        clearTimeout(t);
        res({
          v:v,
          url:url
        });
      };

      v.onerror=function(){
        clearTimeout(t);
        URL.revokeObjectURL(url);
        rej(new Error("decode"));
      };
    });
  }

  function seek(v,time){
    return new Promise(function(res){

      var done=false;

      function fin(){
        if(done) return;
        done=true;
        v.removeEventListener("seeked",fin);
        res();
      }

      v.addEventListener("seeked",fin);
      v.currentTime=time;

      setTimeout(fin,4000);
    });
  }

  /*
   * IMPORTANT:
   * V1 = 4 frames
   * V2 = 12 frames
   *
   * This gives Gemini much more information about
   * the beginning, middle and ending of the video.
   */

  async function extractFrames(f,count){

    var lv=await loadVideo(f);
    var v=lv.v;

    try{

      var w0=v.videoWidth;
      var h0=v.videoHeight;

      if(!w0||!h0)
        throw new Error("decode");

      var dur=
        (isFinite(v.duration)&&v.duration>0)
        ?v.duration
        :1;

      var sc=Math.min(1,1280/w0);
      var out=[];

      for(var i=0;i<count;i++){

        await seek(
          v,
          Math.max(
            0,
            Math.min(
              dur-0.05,
              dur*(i+0.5)/count
            )
          )
        );

        var c=document.createElement("canvas");

        c.width=Math.round(w0*sc);
        c.height=Math.round(h0*sc);

        var ctx=c.getContext("2d");

        ctx.drawImage(
          v,
          0,
          0,
          c.width,
          c.height
        );

        out.push(c);
      }

      return {
        frames:out,
        duration:dur
      };

    }finally{
      URL.revokeObjectURL(lv.url);
    }
  }

  function toBlob(c,maxW){

    var s=Math.min(
      1,
      maxW/c.width
    );

    var o=document.createElement("canvas");

    o.width=Math.round(c.width*s);
    o.height=Math.round(c.height*s);

    o.getContext("2d").drawImage(
      c,
      0,
      0,
      o.width,
      o.height
    );

    return new Promise(function(r){
      o.toBlob(
        r,
        "image/jpeg",
        0.8
      );
    });
  }

  function blobToImage(b){

    return new Promise(function(res,rej){

      var fr=new FileReader();

      fr.onload=function(){

        var s=String(fr.result);

        res({
          mime:"image/jpeg",
          data:s.slice(
            s.indexOf(",")+1
          )
        });
      };

      fr.onerror=function(){
        rej(new Error("read"));
      };

      fr.readAsDataURL(b);
    });
  }


  /* =========================================================
     AI PROMPT
     ========================================================= */

  var PLATFORM_SPEC={

    ytshorts:
      "YouTube Shorts: vertical short video. Title max 70 characters. Include #Shorts among hashtags. 6 to 10 hashtags.",

    ytlong:
      "YouTube long-form video: title max 70 characters. Description 3 to 5 short lines. 6 to 10 hashtags.",

    reels:
      "Instagram Reels: title works as the first caption line, max 90 characters. 6 to 8 hashtags.",

    fb:
      "Facebook video: friendly conversational caption, title max 100 characters. 4 to 6 hashtags."
  };

  var LANG={

    hinglish:
      "Hinglish: Hindi written in Roman script, naturally mixed with English words like Indian creators.",

    hindi:
      "Hindi written in Devanagari script.",

    english:
      "Simple natural English."
  };


  function buildPrompt(n,dur,note){

    return [

      "You are ClipPack's real video understanding and content optimization engine.",

      "",

      "IMPORTANT VIDEO RULE:",

      "The attached images are sequential frames from ONE VIDEO.",

      "Do NOT treat them as unrelated pictures.",

      "Understand the sequence from beginning to middle to ending.",

      "Use the visible video evidence as the primary source.",

      "",

      n>0
        ?(
          "There are "+
          n+
          " frames sampled across the video. "+
          "The video length is about "+
          Math.round(dur)+
          " seconds."
        )
        :"No video frames are attached. Use only the creator note.",

      "",

      "Creator note:",

      "\""+
      (note||"").slice(0,500)+
      "\"",

      "",

      "Output language:",

      LANG[langSel.value],

      "",

      "VIDEO UNDERSTANDING RULES:",

      "1. First understand what is actually happening in the video.",

      "2. Compare the frames as a sequence.",

      "3. Identify the main subject and main action.",

      "4. Notice important changes between early, middle and late frames.",

      "5. Read visible text when possible.",

      "6. Use the actual topic of the video for title, description, hashtags and tags.",

      "7. Never invent people, places, products, events, prices, statistics or dialogue.",

      "8. If something is unclear, stay general instead of guessing.",

      "9. Do not use generic viral titles that do not match the video.",

      "",

      "Fill every field below:",

      "",

      "- score: whole number 0 to 100 based on this specific video's visible hook, clarity and content readiness.",

      "- score_reason: one short reason.",

      "- category: actual video topic in 1 to 3 words.",

      "- hooks: exactly 5 hooks specifically related to this video.",

      "",

      "- platforms: exactly these four keys:",

      "ytshorts: "+
      PLATFORM_SPEC.ytshorts,

      "ytlong: "+
      PLATFORM_SPEC.ytlong,

      "reels: "+
      PLATFORM_SPEC.reels,

      "fb: "+
      PLATFORM_SPEC.fb,

      "",

      "Every platform must contain:",

      "{title, description, hashtags}",

      "",

      "Every description must be 2 to 5 short lines.",

      "Do not put hashtags inside descriptions.",

      "",

      "- tags: 10 to 15 actual YouTube search keywords related to this exact video. No #.",

      "",

      "- thumbnail_text: 2 to 4 punchy words based on the actual key moment.",

      "- thumbnail_emoji: one emoji.",

      "- thumbnail_visual_idea: specific thumbnail idea based on this video.",

      "- best_frame: best frame number for thumbnail.",

      "- best_time: practical Indian posting window. Do not guarantee views.",

      "- risk_note: cautious note if video appears reused/reposted. Never make a legal claim.",

      "- improvements: exactly 3 to 5 specific improvements for this video.",

      "- comment_replies: exactly 3 relevant comment reply ideas.",

      "- summary: one line explaining exactly what you understood.",

      "",

      "IMPORTANT:",

      "Titles, descriptions, hashtags and tags MUST be about the actual video.",

      "Do not return generic metadata.",

      "",

      "Return ONLY valid JSON:",

      JSON.stringify({

        summary:"",

        score:0,

        score_reason:"",

        category:"",

        hooks:["","","","",""],

        platforms:{

          ytshorts:{
            title:"",
            description:"",
            hashtags:["#"]
          },

          ytlong:{
            title:"",
            description:"",
            hashtags:["#"]
          },

          reels:{
            title:"",
            description:"",
            hashtags:["#"]
          },

          fb:{
            title:"",
            description:"",
            hashtags:["#"]
          }
        },

        tags:[""],

        thumbnail_text:"",

        thumbnail_emoji:"",

        thumbnail_visual_idea:"",

        best_frame:1,

        best_time:"",

        risk_note:"",

        improvements:["","",""],

        comment_replies:["","",""]

      })

    ].join("\n");
  }


  /* =========================================================
     SERVER
     ========================================================= */

  var ERR={

    rate_limited:
      "The free AI limit is reached for now. Wait a minute and try again.",

    not_configured:
      "The server isn't set up yet: add GEMINI_API_KEY in Cloudflare.",

    upstream_config:
      "The AI service rejected the request. Check API settings.",

    upstream:
      "The AI service didn't respond. Try again in a moment.",

    invalid_json:
      "The AI answer came back in the wrong format. Generate again.",

    refused:
      "The AI couldn't answer this input. Try another video.",

    bad_request:
      "Add a video or a longer line and try again.",

    bad_image:
      "The video frames were rejected. Try another video.",

    forbidden:
      "This request was blocked.",

    network:
      "Couldn't reach the server. Check your internet and try again."
  };


  async function callApi(prompt,images,signal){

    var res;

    try{

      res=await fetch(
        "/api/generate",
        {
          method:"POST",

          headers:{
            "Content-Type":
              "application/json"
          },

          body:JSON.stringify({
            prompt:prompt,
            images:images
          }),

          signal:signal
        }
      );

    }catch(e){

      if(
        e &&
        e.name==="AbortError"
      ){
        throw {
          code:"cancelled"
        };
      }

      throw {
        code:"network"
      };
    }

    var j=null;

    try{
      j=await res.json();
    }catch(e){}

    if(
      !res.ok ||
      !j ||
      !j.result
    ){

      throw {
        code:
          (j&&j.error) ||
          ("http_"+res.status)
      };
    }

    return j.result;
  }


  function arr(x){
    return Array.isArray(x)
      ?x
      :[];
  }

  function str(x){
    return typeof x==="string"
      ?x.trim()
      :"";
  }

  function busy(b){

    if(bar)
      bar.classList.toggle("on",b);

    if(window.ClipStage)
      window.ClipStage.setBusy(b);
  }


  /* =========================================================
     GENERATE
     ========================================================= */

  if(go){

    go.addEventListener(
      "click",
      async function(){

        if(go.disabled)
          return;

        ctl=new AbortController();

        go.disabled=true;

        if(stopBtn)
          stopBtn.hidden=false;

        busy(true);

        if(results){
          results.hidden=true;
          results.classList.remove("show");
        }

        if(stripWrap)
          stripWrap.hidden=true;

        frames=[];
        bestIdx=0;

        if(dlmsg)
          dlmsg.textContent="";

        generated=false;

        if(aiCtl)
          aiCtl.abort();

        aiImg=null;

        if(aiChip)
          aiChip.hidden=true;

        if(thumbAiStatus)
          thumbAiStatus.textContent="";

        selectStyle("bold");

        var t0=Date.now();
        var timer=null;

        try{

          var images=[];
          var dur=0;
          var note=hint
            ?hint.value.trim()
            :"";

          if(file){

            setStatus(
              "Extracting 12 frames from your video..."
            );

            var r=null;

            try{

              /*
               * V2:
               * 12 frames instead of 4
               */
              r=await extractFrames(
                file,
                12
              );

            }catch(e){

              console.error(
                "Frame extraction:",
                e
              );

              r=null;
            }

            if(r){

              frames=r.frames;
              dur=r.duration;

              var blobs=
                await Promise.all(
                  frames.map(
                    function(f){
                      return toBlob(
                        f,
                        640
                      );
                    }
                  )
                );

              images=
                await Promise.all(
                  blobs.map(
                    blobToImage
                  )
                );

            }else if(
              note.length<10
            ){

              setStatus(
                "This video couldn't be opened. Try another video.",
                "err"
              );

              return;
            }
          }

          timer=setInterval(
            function(){

              setStatus(
                "AI is understanding your video... "+
                Math.round(
                  (Date.now()-t0)/1000
                )+
                " sec"
              );

            },
            1000
          );

          setStatus(
            "AI is understanding your video..."
          );

          var out=await callApi(
            buildPrompt(
              images.length,
              dur,
              note
            ),
            images,
            ctl.signal
          );

          var pin=
            out.platforms &&
            typeof out.platforms==="object"
            ?out.platforms
            :{};

          var anyTitle=
            PLATFORMS.some(
              function(k){
                return (
                  pin[k] &&
                  str(pin[k].title)
                );
              }
            );

          if(!anyTitle)
            throw {
              code:"invalid_json"
            };


          /* PLATFORM DATA */

          var platforms=
            emptyPlatforms();

          PLATFORMS.forEach(
            function(k){

              var p=pin[k]||{};

              platforms[k]={

                title:str(p.title),

                description:
                  str(p.description),

                hashtags:
                  arr(p.hashtags)
                    .map(str)
                    .filter(Boolean)
                    .map(
                      function(h){

                        h=h.replace(
                          /\s+/g,
                          ""
                        );

                        return h.charAt(0)==="#"
                          ?h
                          :"#"+h;
                      }
                    )
                    .slice(0,14)
              };
            }
          );

          data.platforms=platforms;

          data.activePlatform=
            PLATFORMS.indexOf(
              platformSel.value
            )>=0
            ?platformSel.value
            :"ytshorts";


          /* SCORE */

          var sc=parseInt(
            out.score,
            10
          );

          data.score=
            isFinite(sc)
            ?Math.max(
                0,
                Math.min(100,sc)
              )
            :0;

          data.scoreReason=
            str(out.score_reason);

          data.category=
            str(out.category) ||
            "General";


          /* HOOKS */

          data.hooks=
            arr(out.hooks)
              .map(str)
              .filter(Boolean)
              .slice(0,5);


          /* TAGS */

          data.tags=
            arr(out.tags)
              .map(str)
              .filter(Boolean)
              .slice(0,16);


          /* THUMBNAIL */

          data.thumbIdea=
            str(
              out.thumbnail_visual_idea
            );


          /* RISK */

          data.riskNote=
            str(out.risk_note) ||
            "Not enough information to judge from the frames alone.";


          /* IMPROVEMENTS */

          data.improvements=
            arr(out.improvements)
              .map(str)
              .filter(Boolean)
              .slice(0,6);


          /* BEST FRAME */

          var bf=parseInt(
            out.best_frame,
            10
          );

          bestIdx=
            frames.length &&
            bf>=1 &&
            bf<=frames.length
            ?bf-1
            :0;


          /* SUMMARY */

          var summary=
            str(out.summary);

          var summaryEl=$("summary");

          if(summaryEl){

            summaryEl.textContent=
   
