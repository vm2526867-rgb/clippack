/* ============ 3D hero (pure CSS 3D, no libraries) ============ */
(function(){
  "use strict";
  var hero=document.getElementById("hero"), ring=document.getElementById("ring"),
      tilt=document.getElementById("tilt"), stars=document.getElementById("stars");
  var reduce=window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var spin=8, spinTarget=8;
  window.ClipStage={setBusy:function(b){ spinTarget=b?90:8; }};
  if(!hero||!ring||!tilt) return;

  var PAL=[["#6C7BFF","#FF5C7C","#FFB43A"],["#FFB43A","#FF5C7C","#6C7BFF"],["#47E0B8","#6C7BFF","#FF5C7C"],["#FF5C7C","#8A5BFF","#FFB43A"]];
  var LAB=["#Shorts","Title \u2713","#Reels","Tags \u2713","#YouTube","Thumbnail \u2713"];
  var N=9, cards=[];
  for(var i=0;i<N;i++){
    var p=PAL[i%PAL.length], c=document.createElement("div");
    c.className="card3d";
    c.style.setProperty("--i",i);
    c.style.setProperty("--c1",p[0]); c.style.setProperty("--c2",p[1]); c.style.setProperty("--c3",p[2]);
    c.innerHTML='<div class="face front"><i class="play"></i><i class="bar"></i><i class="l1"></i><i class="l2"></i><b class="chip"></b></div><div class="face back"></div>';
    c.querySelector(".chip").textContent=LAB[i%LAB.length];
    ring.appendChild(c); cards.push(c);
  }

  function makeStars(){
    if(!stars) return;
    var w=hero.clientWidth||400, h=hero.clientHeight||700, s=[];
    for(var k=0;k<70;k++){
      s.push(Math.round(Math.random()*w)+"px "+Math.round(Math.random()*h)+"px 0 "+(Math.random()<0.2?1:0)+"px rgba(255,255,255,"+(0.25+Math.random()*0.5).toFixed(2)+")");
    }
    stars.style.boxShadow=s.join(",");
  }
  makeStars();
  if("ResizeObserver" in window){ new ResizeObserver(makeStars).observe(hero); }

  var rot=20, px=0, py=0, tpx=0, tpy=0, last=0, raf=0, visible=true;
  window.addEventListener("pointermove",function(e){
    tpx=(e.clientX/window.innerWidth-0.5)*2; tpy=(e.clientY/window.innerHeight-0.5)*2;
  },{passive:true});

  function apply(t){
    var deg=rot+(window.scrollY||0)*0.16;
    ring.style.transform="rotateY("+deg.toFixed(2)+"deg)";
    tilt.style.transform="rotateX("+(-py*6).toFixed(2)+"deg) rotateY("+(px*6).toFixed(2)+"deg)";
    for(var i=0;i<cards.length;i++){
      var z=Math.cos((i*40+deg)*Math.PI/180);
      cards[i].style.setProperty("--o",(0.3+0.7*(z+1)/2).toFixed(3));
      cards[i].style.setProperty("--bob",(Math.sin(t*0.0009+i*0.9)*4).toFixed(2)+"px");
    }
  }
  function frame(t){
    if(!visible){ raf=0; return; }
    var dt=Math.min(0.05,(t-last)/1000); last=t;
    spin+=(spinTarget-spin)*Math.min(1,dt*3);
    rot+=spin*dt;
    px+=(tpx-px)*0.06; py+=(tpy-py)*0.06;
    apply(t);
    raf=requestAnimationFrame(frame);
  }
  function start(){ if(reduce||raf||!visible) return; last=performance.now(); raf=requestAnimationFrame(frame); }
  if("IntersectionObserver" in window){
    new IntersectionObserver(function(en){ visible=en[0].isIntersecting; if(visible) start(); },{threshold:0}).observe(hero);
  }
  document.addEventListener("visibilitychange",function(){ visible=!document.hidden; if(visible) start(); });
  apply(0);
  if(!reduce) start();
})();
