"use strict";
class STLViewer {
  constructor(canvas) {
    this.canvas=canvas;this.yaw=-.55;this.pitch=.6;this.zoom=1;this.mode="thickness";this.arrows=true;this.lineWidth=.45;this.layer=.2;
    this.gl=canvas.getContext("webgl",{antialias:true,alpha:false,preserveDrawingBuffer:true});
    if(this.gl) this.initGL(); else this.ctx=canvas.getContext("2d");
    let dragging=false,last=[0,0];
    canvas.addEventListener("pointerdown",e=>{dragging=true;last=[e.clientX,e.clientY];canvas.setPointerCapture(e.pointerId);});
    canvas.addEventListener("pointermove",e=>{if(!dragging)return;this.yaw+=(e.clientX-last[0])*.009;this.pitch=STLCore.math.clamp(this.pitch+(e.clientY-last[1])*.009,-1.5,1.5);last=[e.clientX,e.clientY];this.draw();});
    canvas.addEventListener("pointerup",()=>dragging=false);canvas.addEventListener("pointercancel",()=>dragging=false);
    canvas.addEventListener("wheel",e=>{e.preventDefault();this.zoom=STLCore.math.clamp(this.zoom*Math.exp(-e.deltaY*.001),.2,6);this.draw();},{passive:false});
    new ResizeObserver(()=>this.draw()).observe(canvas);
  }
  reset(){this.yaw=-.55;this.pitch=.6;this.zoom=1;this.draw();}
  initGL() {
    const gl=this.gl;
    const shader=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
    const vert=shader(gl.VERTEX_SHADER,`attribute vec3 aPosition; attribute vec3 aNormal; attribute float aThickness; attribute vec3 aColor;
      uniform mat4 uView; uniform float uPointSize; varying vec3 vNormal; varying float vThickness; varying vec3 vColor; varying float vHeight;
      void main(){gl_Position=uView*vec4(aPosition,1.);gl_PointSize=uPointSize;vNormal=aNormal;vThickness=aThickness;vColor=aColor;vHeight=aPosition.z;}`);
    const frag=shader(gl.FRAGMENT_SHADER,`precision mediump float; varying vec3 vNormal; varying float vThickness; varying vec3 vColor; varying float vHeight;
      uniform float uMode; uniform float uWidth; uniform float uLayer; uniform float uPoints;
      void main(){ vec3 color=vec3(.39,.51,.65);
        if(uMode>3.5) color=vColor;
        else if(uMode>2.5) color=vNormal.z<-.7071?vec3(1.,.76,.42):vec3(.39,.51,.65);
        else if(uMode>1.5){float stripe=step(.40,fract(vHeight/max(uLayer,.001)));color=mix(vec3(.32,.40,.52),vec3(.57,.67,.80),stripe);}
        else if(uMode>.5 && vThickness>=0.){color=vThickness<2.*uWidth?vec3(.77,.65,1.):vThickness<4.*uWidth?vec3(1.,.76,.42):vec3(.41,.84,.93);}
        if(uPoints>.5){if(distance(gl_PointCoord,vec2(.5))>.5)discard;gl_FragColor=vec4(color,1.);}
        else if(uMode>3.5)gl_FragColor=vec4(color,1.);
        else{float light=.42+.58*abs(dot(normalize(vNormal),normalize(vec3(.3,-.45,.8))));gl_FragColor=vec4(color*light,1.);}}
    `);
    const p=gl.createProgram();gl.attachShader(p,vert);gl.attachShader(p,frag);gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));
    this.program=p;gl.useProgram(p);this.loc={};
    for(const name of ["aPosition","aNormal","aThickness","aColor"])this.loc[name]=gl.getAttribLocation(p,name);
    for(const name of ["uView","uPointSize","uMode","uWidth","uLayer","uPoints"])this.loc[name]=gl.getUniformLocation(p,name);
    this.meshBuffer=gl.createBuffer();this.pointBuffer=gl.createBuffer();this.lineBuffer=gl.createBuffer();
    gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.clearColor(.063,.098,.145,1);
  }
  setModel(data,o) {
    this.data=data;this.o=o;
    const {dot}=STLCore.math,rows=[o.u,o.v,o.n];this.center=o.size.map(x=>x/2);this.span=Math.max(...o.size)*1.42;
    const transform=p=>rows.map((r,k)=>dot(p,r)-o.lo[k]-this.center[k]);
    this.transform=transform;const thickness=new Map(data.thickness.samples.filter(s=>s.thickness!==null).map(s=>[s.face,s.thickness]));
    // Full-resolution geometry is analyzed/exported. Display is capped at 60,000 facets.
    const step=Math.max(1,Math.ceil(data.count/60000)),shown=Math.ceil(data.count/step),verts=new Float32Array(shown*30);
    let at=0;this.displayTriangles=[];
    for(let i=0;i<data.count;i+=step) {
      const n=rows.map(r=>dot(Array.from(data.normals.subarray(i*3,i*3+3)),r)),tri=[];
      for(let j=0;j<3;j++) {
        const p=transform(Array.from(data.positions.subarray(i*9+j*3,i*9+j*3+3)));tri.push(p);
        verts.set([...p,...n,thickness.get(i)??-1,0,0,0],at);at+=10;
      }
      if(this.displayTriangles.length<1600)this.displayTriangles.push({p:tri,n,t:thickness.get(i)??-1});
    }
    this.vertexCount=at/10;this.verts=verts;
    const points=[];
    for(const s of data.thickness.samples)if(s.thickness!==null) {
      const n=rows.map(r=>dot(s.n,r)),p=transform(s.p).map((x,k)=>x+n[k]*this.span*.0008);
      points.push(...p,...n,s.thickness,0,0,0);
    }
    this.pointVerts=new Float32Array(points);this.makeLines();
    if(this.gl){const gl=this.gl;gl.bindBuffer(gl.ARRAY_BUFFER,this.meshBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.verts,gl.STATIC_DRAW);gl.bindBuffer(gl.ARRAY_BUFFER,this.pointBuffer);gl.bufferData(gl.ARRAY_BUFFER,this.pointVerts,gl.STATIC_DRAW);}
    this.draw();
  }
  makeLines() {
    if(!this.o)return;
    const o=this.o,lines=[],span=this.span,origin=[-this.center[0],-this.center[1],-this.center[2]-.002*span];
    const line=(a,b,color)=>{for(const p of [a,b])lines.push(...p,0,0,1,-1,...color);};
    const xhalf=Math.max(o.size[0]/2,span*.2),yhalf=Math.max(o.size[1]/2,span*.2),z=-this.center[2]-.006*span;
    for(let i=-5;i<=5;i++){line([i*xhalf/5,-yhalf,z],[i*xhalf/5,yhalf,z],[.19,.26,.34]);line([-xhalf,i*yhalf/5,z],[xhalf,i*yhalf/5,z],[.19,.26,.34]);}
    const arrow=(from,to,color)=>{
      line(from,to,color);const d=STLCore.math.unit(STLCore.math.sub(to,from)),reference=Math.abs(d[2])>.9?[0,1,0]:[0,0,1];
      const side=STLCore.math.unit(STLCore.math.cross(d,reference)),back=STLCore.math.sub(to,STLCore.math.mul(d,span*.05));
      line(to,STLCore.math.add(back,STLCore.math.mul(side,span*.022)),color);line(to,STLCore.math.sub(back,STLCore.math.mul(side,span*.022)),color);
    };
    this.gridCount=lines.length/10;
    arrow(origin,STLCore.math.add(origin,[span*.22,0,0]),[.41,.84,.93]);
    arrow(origin,STLCore.math.add(origin,[0,span*.22,0]),[1,.76,.42]);
    arrow(origin,STLCore.math.add(origin,[0,0,span*.3]),[.77,.65,1]);
    if(this.load!="unknown") {
      const a=[0,0,0];a[this.axis||0]=1;const direction=[o.u,o.v,o.n].map(r=>STLCore.math.dot(r,a));
      const from=STLCore.math.mul(direction,-span*.29),to=STLCore.math.mul(direction,span*.29);
      arrow(from,to,[.41,.84,.93]);arrow(to,from,[.41,.84,.93]);
    }
    this.lines=new Float32Array(lines);if(this.gl){this.gl.bindBuffer(this.gl.ARRAY_BUFFER,this.lineBuffer);this.gl.bufferData(this.gl.ARRAY_BUFFER,this.lines,this.gl.STATIC_DRAW);}
  }
  viewMatrix() {
    const c=Math.cos(this.yaw),s=Math.sin(this.yaw),p=Math.sin(this.pitch),q=Math.cos(this.pitch),aspect=this.canvas.width/this.canvas.height;
    const size=this.o.size,horizontal=Math.abs(c)*size[0]+Math.abs(s)*size[1],vertical=Math.abs(s*p)*size[0]+Math.abs(c*p)*size[1]+Math.abs(q)*size[2];
    const scale=Math.min(1.50*aspect/(horizontal||this.span),1.35/(vertical||this.span))*this.zoom,sy=scale,sx=scale/aspect,sz=.48/this.span;
    // Z-up orthographic view: horizontal rotates around print Z.
    return new Float32Array([c*sx,s*p*sy,s*q*sz,0,-s*sx,c*p*sy,c*q*sz,0,0,q*sy,-p*sz,0,0,0,0,1]);
  }
  draw() {
    const ratio=Math.min(window.devicePixelRatio||1,2),w=Math.max(1,Math.round(this.canvas.clientWidth*ratio)),h=Math.max(1,Math.round(this.canvas.clientHeight*ratio));
    if(this.canvas.width!==w||this.canvas.height!==h){this.canvas.width=w;this.canvas.height=h;}
    if(!this.data)return;
    if(!this.gl){this.draw2D();return;}
    const gl=this.gl,l=this.loc;gl.viewport(0,0,w,h);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.useProgram(this.program);
    gl.uniformMatrix4fv(l.uView,false,this.viewMatrix());gl.uniform1f(l.uWidth,this.lineWidth);gl.uniform1f(l.uLayer,this.layer);gl.uniform1f(l.uPointSize,6*ratio);gl.uniform1f(l.uPoints,0);
    const bind=buffer=>{
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      for(const [name,size,offset] of [["aPosition",3,0],["aNormal",3,12],["aThickness",1,24],["aColor",3,28]]){gl.enableVertexAttribArray(l[name]);gl.vertexAttribPointer(l[name],size,gl.FLOAT,false,40,offset);}
    };
    bind(this.lineBuffer);gl.uniform1f(l.uMode,4);gl.drawArrays(gl.LINES,0,this.gridCount);
    bind(this.meshBuffer);gl.uniform1f(l.uMode,{plain:0,thickness:1,layers:2,overhang:3}[this.mode]);gl.drawArrays(gl.TRIANGLES,0,this.vertexCount);
    if(this.mode==="thickness"&&this.pointVerts.length){bind(this.pointBuffer);gl.uniform1f(l.uPoints,1);gl.drawArrays(gl.POINTS,0,this.pointVerts.length/10);}
    if(this.arrows){bind(this.lineBuffer);gl.uniform1f(l.uPoints,0);gl.uniform1f(l.uMode,4);gl.disable(gl.DEPTH_TEST);gl.drawArrays(gl.LINES,this.gridCount,this.lines.length/10-this.gridCount);gl.enable(gl.DEPTH_TEST);}
  }
  project(p) {
    const m=this.viewMatrix(),x=p[0],y=p[1],z=p[2];
    return [(1+m[0]*x+m[4]*y+m[8]*z)*this.canvas.width/2,(1-m[1]*x-m[5]*y-m[9]*z)*this.canvas.height/2,m[2]*x+m[6]*y+m[10]*z];
  }
  draw2D() {
    const ctx=this.ctx;ctx.fillStyle="#101925";ctx.fillRect(0,0,this.canvas.width,this.canvas.height);
    const tris=this.displayTriangles.map(t=>({...t,p:t.p.map(p=>this.project(p))})).sort((a,b)=>b.p.reduce((s,p)=>s+p[2],0)-a.p.reduce((s,p)=>s+p[2],0));
    for(const t of tris){ctx.beginPath();ctx.moveTo(t.p[0][0],t.p[0][1]);for(let i=1;i<3;i++)ctx.lineTo(t.p[i][0],t.p[i][1]);ctx.closePath();ctx.fillStyle=this.mode==="overhang"&&t.n[2]<-.7071?"#ffc26a":this.mode==="thickness"&&t.t>=0?(t.t<2*this.lineWidth?"#c4a5ff":t.t<4*this.lineWidth?"#ffc26a":"#69d5ee"):"#637f9c";ctx.fill();ctx.strokeStyle="#304254";ctx.stroke();}
    if(this.mode==="thickness")for(let i=0;i<this.pointVerts.length;i+=10){const p=this.project(Array.from(this.pointVerts.subarray(i,i+3))),t=this.pointVerts[i+6];ctx.fillStyle=t<2*this.lineWidth?"#c4a5ff":t<4*this.lineWidth?"#ffc26a":"#69d5ee";ctx.beginPath();ctx.arc(p[0],p[1],3,0,Math.PI*2);ctx.fill();}
    for(let i=0;i<(this.arrows?this.lines.length:this.gridCount*10);i+=20){const a=this.project(Array.from(this.lines.subarray(i,i+3))),b=this.project(Array.from(this.lines.subarray(i+10,i+13))),color=this.lines.subarray(i+7,i+10);ctx.strokeStyle=`rgb(${Array.from(color).map(v=>Math.round(v*255)).join(",")})`;ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();}
    ctx.fillStyle="#a9b8cb";ctx.font="13px Segoe UI";ctx.fillText("Simplified canvas view · WebGL unavailable",12,22);
  }
}
