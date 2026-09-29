/* STL Strength Analyzer 1.0. Geometry screening, not finite-element analysis. */
"use strict";
const STLCore = (() => {
  const MAX_FACES = 200000, MAX_BYTES = 32 * 1024 * 1024;
  const add = (a,b) => a.map((x,i)=>x+b[i]);
  const sub = (a,b) => a.map((x,i)=>x-b[i]);
  const mul = (a,s) => a.map(x=>x*s);
  const dot = (a,b) => a.reduce((s,x,i)=>s+x*b[i],0);
  const cross = (a,b) => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const norm = a => Math.hypot(...a);
  const unit = a => mul(a,1/(norm(a)||1));
  const clamp = (x,a,b) => Math.max(a,Math.min(b,x));
  const pt = (p,i,j=0) => [p[i*9+j*3],p[i*9+j*3+1],p[i*9+j*3+2]];
  const percentile = (a,q) => { const s=a.slice().sort((x,y)=>x-y); return s.length?s[Math.min(s.length-1,Math.floor(q*(s.length-1)))]:null; };

  function parseSTL(buffer, scale=1) {
    if (!(scale>0) || !Number.isFinite(scale)) throw Error("Scale must be a finite positive number.");
    if (buffer.byteLength > MAX_BYTES) throw Error("This version accepts STLs up to 32 MB and 200,000 triangles. Simplify a copy in your CAD software.");
    const dv=new DataView(buffer), count=buffer.byteLength>=84?dv.getUint32(80,true):0;
    const exactBinary=count>0 && 84+count*50===buffer.byteLength;
    let raw, format;
    if(exactBinary) {
      if(count>MAX_FACES) throw Error("Triangle limit exceeded (200,000). Simplify a copy first.");
      raw=new Float64Array(count*9); format="Binary STL";
      for(let i=0;i<count;i++) for(let j=0;j<9;j++) raw[i*9+j]=dv.getFloat32(84+i*50+12+j*4,true)*scale;
    } else {
      const text=new TextDecoder().decode(buffer);
      if(!/^\s*solid\b/i.test(text)) throw Error("STL is truncated, malformed, or not a standard binary/ASCII STL.");
      const facets=text.match(/\bfacet\b[\s\S]*?\bendfacet\b/gi)||[];
      if(!facets.length || facets.length>MAX_FACES) throw Error("No valid facets, or more than 200,000 triangles.");
      if((text.match(/\bfacet\b/gi)||[]).length!==facets.length) throw Error("ASCII STL has an incomplete facet.");
      raw=new Float64Array(facets.length*9);format="ASCII STL";
      facets.forEach((f,i)=>{
        const vertices=[...f.matchAll(/\bvertex\s+(\S+)\s+(\S+)\s+(\S+)/gi)];
        if(vertices.length!==3) throw Error("Every ASCII STL facet must have exactly three vertices.");
        for(let v=0;v<3;v++) for(let k=0;k<3;k++) raw[i*9+v*3+k]=Number(vertices[v][k+1])*scale;
      });
    }
    if(!raw.every(Number.isFinite)) throw Error("STL contains NaN, infinity, or invalid coordinates.");
    let lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(let i=0;i<raw.length;i++) {const a=i%3;lo[a]=Math.min(lo[a],raw[i]);hi[a]=Math.max(hi[a],raw[i]);}
    const center=mul(add(lo,hi),.5), diag=norm(sub(hi,lo));
    if(!(diag>0) || diag>1e7 || diag<1e-5) throw Error("Model size is zero or implausible. Check the STL units and scale.");
    // Center in double precision before GPU conversion. Large world offsets stay harmless.
    const kept=[]; let removed=0;
    for(let i=0;i<raw.length/9;i++) {
      const a=sub(pt(raw,i,0),center),b=sub(pt(raw,i,1),center),c=sub(pt(raw,i,2),center);
      if(norm(cross(sub(b,a),sub(c,a)))<diag*diag*1e-14) {removed++;continue;}
      kept.push(...a,...b,...c);
    }
    if(kept.length<9) throw Error("All STL facets have zero area.");
    return {positions:new Float64Array(kept),format,removed,originalCenter:center};
  }

  function meshInfo(positions) {
    const count=positions.length/9, areas=new Float64Array(count), normals=new Float64Array(count*3);
    const centroids=new Float64Array(count*3), triBounds=new Float64Array(count*6);
    let lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],surfaceArea=0,signedVolume=0;
    for(let i=0;i<count;i++) {
      const a=pt(positions,i,0),b=pt(positions,i,1),c=pt(positions,i,2),cr=cross(sub(b,a),sub(c,a));
      const area=norm(cr)/2;areas[i]=area;surfaceArea+=area;normals.set(unit(cr),i*3);
      centroids.set(mul(add(add(a,b),c),1/3),i*3);signedVolume+=dot(a,cross(b,c))/6;
      for(let k=0;k<3;k++) {
        const mn=Math.min(a[k],b[k],c[k]),mx=Math.max(a[k],b[k],c[k]);
        triBounds[i*6+k]=mn;triBounds[i*6+3+k]=mx;lo[k]=Math.min(lo[k],mn);hi[k]=Math.max(hi[k],mx);
      }
    }
    return {positions,count,areas,normals,centroids,triBounds,lo,hi,size:sub(hi,lo),diag:norm(sub(hi,lo)),surfaceArea,signedVolume};
  }

  function topology(mesh) {
    const tolerance=Math.max(1e-7,mesh.diag*1e-8), vertices=new Map(),edges=new Map();
    const parent=new Int32Array(mesh.count);for(let i=0;i<parent.length;i++)parent[i]=i;
    const root=i=>{while(parent[i]!==i){parent[i]=parent[parent[i]];i=parent[i];}return i;};
    const join=(a,b)=>{a=root(a);b=root(b);if(a!==b)parent[b]=a;};
    let boundary=0,nonmanifold=0,winding=0,collapsed=0;
    for(let i=0;i<mesh.count;i++) {
      const ids=[];
      for(let j=0;j<3;j++) {
        const key=pt(mesh.positions,i,j).map(x=>Math.round(x/tolerance)).join(",");
        if(!vertices.has(key))vertices.set(key,vertices.size);ids.push(vertices.get(key));
      }
      if(new Set(ids).size!==3) collapsed++;
      for(let j=0;j<3;j++) {
        const a=ids[j],b=ids[(j+1)%3],key=a<b?`${a}:${b}`:`${b}:${a}`,direction=a<b?1:-1;
        if(edges.has(key)) {const e=edges.get(key);e.count++;e.sum+=direction;join(i,e.face);}
        else edges.set(key,{count:1,sum:direction,face:i});
      }
    }
    for(const e of edges.values()) {if(e.count===1)boundary++;else if(e.count!==2)nonmanifold++;else if(e.sum!==0)winding++;}
    const components=new Set();for(let i=0;i<mesh.count;i++)components.add(root(i));
    return {vertices:vertices.size,boundary,nonmanifold,winding,collapsed,components:components.size,
      closed:boundary===0&&nonmanifold===0&&winding===0&&collapsed===0,tolerance};
  }

  function buildBVH(mesh, indices=null) {
    indices=indices||Array.from({length:mesh.count},(_,i)=>i);
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    for(const i of indices)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],mesh.triBounds[i*6+k]);hi[k]=Math.max(hi[k],mesh.triBounds[i*6+3+k]);}
    if(indices.length<=10)return {lo,hi,indices};
    const span=sub(hi,lo),axis=span.indexOf(Math.max(...span)),mid=Math.floor(indices.length/2);
    indices.sort((a,b)=>mesh.centroids[a*3+axis]-mesh.centroids[b*3+axis]);
    return {lo,hi,left:buildBVH(mesh,indices.slice(0,mid)),right:buildBVH(mesh,indices.slice(mid))};
  }

  function rayBox(node,p,d,limit) {
    let enter=0,leave=limit;
    for(let k=0;k<3;k++) {
      if(Math.abs(d[k])<1e-12) {if(p[k]<node.lo[k]||p[k]>node.hi[k])return false;continue;}
      let a=(node.lo[k]-p[k])/d[k],b=(node.hi[k]-p[k])/d[k];if(a>b)[a,b]=[b,a];
      enter=Math.max(enter,a);leave=Math.min(leave,b);if(enter>leave)return false;
    }
    return leave>=0;
  }

  function rayTriangle(mesh,i,p,d) {
    const a=pt(mesh.positions,i,0),e1=sub(pt(mesh.positions,i,1),a),e2=sub(pt(mesh.positions,i,2),a);
    const h=cross(d,e2),det=dot(e1,h);
    if(Math.abs(det)<1e-12*mesh.diag*mesh.diag)return Infinity;
    const inv=1/det,s=sub(p,a),u=inv*dot(s,h);if(u< -1e-8||u>1+1e-8)return Infinity;
    const q=cross(s,e1),v=inv*dot(d,q);if(v< -1e-8||u+v>1+1e-8)return Infinity;
    const t=inv*dot(e2,q);return t>mesh.diag*1e-9?t:Infinity;
  }

  function rayHit(mesh,bvh,p,d,exclude=-1) {
    let best=Infinity,face=-1;const stack=[bvh];
    while(stack.length) {
      const node=stack.pop();if(!rayBox(node,p,d,best))continue;
      if(node.indices) for(const i of node.indices) {if(i===exclude)continue;const t=rayTriangle(mesh,i,p,d);if(t<best){best=t;face=i;}}
      else {stack.push(node.left,node.right);}
    }
    return {t:best,face};
  }

  function sampleThickness(mesh,bvh,budget=1100) {
    const ids=[];
    if(mesh.count<=budget)for(let i=0;i<mesh.count;i++)ids.push(i);
    else {
      // Half the budget covers facet indices; half is stratified by surface area.
      // This samples small features without letting dense tessellation dominate entirely.
      const half=Math.floor(budget/2);
      for(let j=0;j<half;j++)ids.push(Math.floor(j*mesh.count/half));
      let i=0,cumulative=mesh.areas[0];
      for(let j=0;j<half;j++) {
        const target=(j+.5)*mesh.surfaceArea/half;
        while(cumulative<target&&i<mesh.count-1){i++;cumulative+=mesh.areas[i];}ids.push(i);
      }
    }
    const samples=[],eps=mesh.diag*1e-7;
    for(const face of new Set(ids)) {
      const p=Array.from(mesh.centroids.subarray(face*3,face*3+3)),n=Array.from(mesh.normals.subarray(face*3,face*3+3));
      const hit=rayHit(mesh,bvh,sub(p,mul(n,eps)),mul(n,-1),face);
      const hitNormal=hit.face>=0?Array.from(mesh.normals.subarray(hit.face*3,hit.face*3+3)):n;
      const thickness=Number.isFinite(hit.t)&&dot(n,hitNormal)<-.25?hit.t+eps:null;
      samples.push({face,p,n,thickness});
    }
    const values=samples.map(s=>s.thickness).filter(x=>x!==null);
    return {samples,minimum:values.length?Math.min(...values):null,p10:percentile(values,.1),median:percentile(values,.5),
      valid:values.length,attempted:samples.length};
  }

  function sections(mesh,axis,steps=37) {
    const b=(axis+1)%3,c=(axis+2)%3,span=mesh.size[axis],values=[];
    for(let s=0;s<steps;s++) {
      const fraction=(s+.37)/(steps-.26),plane=mesh.lo[axis]+span*fraction;let twiceArea=0;
      for(let i=0;i<mesh.count;i++) {
        if(plane<=mesh.triBounds[i*6+axis]||plane>=mesh.triBounds[i*6+3+axis])continue;
        const vertices=[pt(mesh.positions,i,0),pt(mesh.positions,i,1),pt(mesh.positions,i,2)],hits=[];
        for(let j=0;j<3;j++) {
          const p=vertices[j],q=vertices[(j+1)%3],da=p[axis]-plane,db=q[axis]-plane;
          if((da<0&&db>=0)||(db<0&&da>=0)) {
            const t=da/(da-db);hits.push(add(p,mul(sub(q,p),t)));
          }
        }
        if(hits.length!==2)continue;
        let [p,q]=hits;const normal=Array.from(mesh.normals.subarray(i*3,i*3+3)),sliceNormal=[0,0,0];sliceNormal[axis]=1;
        if(dot(sub(q,p),cross(sliceNormal,normal))<0)[p,q]=[q,p];
        twiceArea+=p[b]*q[c]-q[b]*p[c];
      }
      values.push({position:plane,fraction,area:Math.abs(twiceArea)*.5});
    }
    const interior=values.filter(v=>v.fraction>=.15&&v.fraction<=.85);
    const positive=interior.filter(v=>v.area>mesh.diag*mesh.diag*1e-10);
    const min=positive.length?positive.reduce((a,b)=>a.area<b.area?a:b):null;
    const peak=percentile(positive.map(v=>v.area),.9);
    return {axis,values,minimum:min?.area??null,position:min?.position??null,peak,ratio:min&&peak?min.area/peak:null};
  }

  function basis(n) {
    n=unit(n);let u;
    if(Math.abs(n[2])>.9999)u=[n[2]>0?1:-1,0,0];
    else u=unit(cross([0,0,1],n));
    return {n,u,v:cross(n,u)};
  }

  function orientationStats(mesh,n,label,id) {
    const axes=basis(n),lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];
    const rows=[axes.u,axes.v,axes.n];
    for(let i=0;i<mesh.positions.length;i+=3) {
      const p=Array.from(mesh.positions.subarray(i,i+3));
      for(let k=0;k<3;k++){const val=dot(p,rows[k]);lo[k]=Math.min(lo[k],val);hi[k]=Math.max(hi[k],val);}
    }
    const size=sub(hi,lo),bedTolerance=Math.max(1e-6,mesh.diag*1e-6);let contact=0,overhang=0;
    for(let i=0;i<mesh.count;i++) {
      const heights=[0,1,2].map(j=>dot(pt(mesh.positions,i,j),axes.n));
      const normal=Array.from(mesh.normals.subarray(i*3,i*3+3)),nz=dot(normal,axes.n);
      if(Math.max(...heights)-lo[2]<=bedTolerance)contact+=mesh.areas[i]*Math.abs(nz);
      else if(nz< -Math.SQRT1_2)overhang+=mesh.areas[i];
    }
    return {id,label,...axes,lo,hi,size,contact,contactRatio:contact/(size[0]*size[1]||1),
      overhangFraction:overhang/mesh.surfaceArea,tallness:size[2]/(Math.min(size[0],size[1])||1)};
  }

  function candidates(mesh) {
    const out=[];
    for(let a=0;a<3;a++)for(const sign of [1,-1]) {
      const n=[0,0,0];n[a]=sign;out.push(orientationStats(mesh,n,`${sign>0?"+":"−"}${"XYZ"[a]} points up`,`${"XYZ"[a]}${sign}`));
    }
    const groups=new Map();
    for(let i=0;i<mesh.count;i++) {
      const n=Array.from(mesh.normals.subarray(i*3,i*3+3)),key=n.map(x=>Math.round(x*25)).join(",");
      if(!groups.has(key))groups.set(key,{area:0,n});groups.get(key).area+=mesh.areas[i];
    }
    let f=0;
    for(const g of [...groups.values()].sort((a,b)=>b.area-a.area)) {
      if(g.area<mesh.surfaceArea*.005)continue;
      const n=mul(g.n,-1);if(out.some(o=>dot(o.n,n)>.997))continue;
      out.push(orientationStats(mesh,n,`Flat-face candidate ${++f}`,`face${f}`));if(f>=8)break;
    }
    return out;
  }

  function analyze(buffer,scale=1,progress=()=>{}) {
    progress("Reading triangles…");const parsed=parseSTL(buffer,scale),mesh=meshInfo(parsed.positions);
    progress("Checking shared edges and winding…");const topo=topology(mesh);
    // Normalize a globally reversed closed shell for geometric queries only.
    if(topo.closed&&mesh.signedVolume<0)for(let i=0;i<mesh.normals.length;i++)mesh.normals[i]*=-1;
    let thickness={samples:[],minimum:null,p10:null,median:null,valid:0,attempted:0},crossSections=[];
    const reliable=topo.closed&&topo.components===1&&Math.abs(mesh.signedVolume)>mesh.diag**3*1e-12;
    if(reliable) {
      progress("Sampling inward rays for approximate thickness…");thickness=sampleThickness(mesh,buildBVH(mesh));
      progress("Measuring cross-sections along X, Y and Z…");crossSections=[0,1,2].map(a=>sections(mesh,a));
    }
    progress("Comparing print orientations…");const orientations=candidates(mesh);
    return {positions:new Float32Array(mesh.positions),normals:new Float32Array(mesh.normals),count:mesh.count,
      format:parsed.format,removed:parsed.removed,originalCenter:parsed.originalCenter,size:mesh.size,surfaceArea:mesh.surfaceArea,
      topology:topo,reliable,volume:reliable?Math.abs(mesh.signedVolume):null,thickness,sections:crossSections,orientations};
  }

  function rank(result,inputs) {
    const a=Number(inputs.axis)||0,stressAxis=[0,0,0];stressAxis[a]=1;
    const directional=inputs.load==="tension"||inputs.load==="bending";
    return result.orientations.map(original=> {
      let o=original;const beds=inputs.bed||[220,220,250];
      const direct=o.size[0]<=beds[0]&&o.size[1]<=beds[1],swapped=o.size[1]<=beds[0]&&o.size[0]<=beds[1];
      if(!direct&&swapped)o={...o,u:o.v,v:mul(o.u,-1),size:[o.size[1],o.size[0],o.size[2]],
        lo:[o.lo[1],-o.hi[0],o.lo[2]],hi:[o.hi[1],-o.lo[0],o.hi[2]],label:o.label+" · bed rotated 90°"};
      const fits=o.size[2]<=beds[2] &&(direct||swapped);
      const alignment=Math.abs(dot(o.n,stressAxis));
      const printability=.50*clamp(o.contactRatio/.35,0,1)+.30*(1-clamp(o.overhangFraction/.25,0,1))+
        .20*(1-clamp(o.tallness/5,0,1));
      const score=(fits?0:-5)+(directional?.62*(1-alignment*alignment)+.38*printability:printability);
      return {...o,fits,alignment,directional,score};
    }).sort((a,b)=>b.score-a.score);
  }

  function settings(result,inputs,orientation) {
    const nozzle=Number(inputs.nozzle),lineWidth=nozzle*1.125;
    const duty=inputs.duty||"functional",load=inputs.load||"unknown",purpose=inputs.purpose||"general";
    const walls=duty==="light"?3:duty==="demanding"?6:4;
    const layer=nozzle<=.4?(duty==="demanding"?.16:.20):.28;
    const solidThickness=duty==="demanding"?1.6:1.2,solidLayers=Math.ceil((solidThickness-1e-9)/layer);
    const infill=duty==="light"?20:duty==="demanding"?(load==="compression"?55:45):(load==="compression"?40:30);
    let material="PETG",why="A practical starting material for general functional parts, with good toughness and layer adhesion.";
    if(purpose==="rigid") {material="PLA";why="Useful for rigid indoor parts at room temperature. Check brittleness and long-term creep for your application.";}
    if(purpose==="outdoor"||purpose==="warm") {
      material="ASA";why="A candidate for UV exposure or warmer service; confirm the specific filament datasheet and service temperature.";
      if(!inputs.enclosure||!inputs.hotend)why+=" Your selected printer capabilities are not ready for this recommendation: use an enclosure and a hotend rated for the filament's print temperature.";
    }
    if(purpose==="flex") {material="TPU 95A";why="For deliberately flexible parts. A soft part cannot substitute for a rigid structural bracket; calibrate TPU on your direct-drive setup.";}
    const thin=result.thickness.minimum,flags=[];
    if(thin!==null&&thin<2*lineWidth)flags.push(`A sampled region is ${thin.toFixed(2)} mm thick, under two estimated extrusion lines (${(2*lineWidth).toFixed(2)} mm). Increasing the wall setting cannot enlarge that geometry.`);
    else if(thin!==null&&thin<4*lineWidth)flags.push(`A sampled region is ${thin.toFixed(2)} mm thick. Preview the actual perimeter paths; thin webs may fill solid before reaching ${walls} walls on each side.`);
    if(orientation&&!orientation.fits)flags.push("No selected orientation fits the entered build volume. Split or resize a copy; inspect fit in the slicer.");
    if(orientation&&orientation.contactRatio<.04)flags.push("Very little estimated flat bed contact. Consider a brim, a CAD flat, or another orientation.");
    if(orientation&&orientation.overhangFraction>.03)flags.push("Steep downward faces are present. Check support and bridging in the slicer preview; the surface estimate is not a support-volume calculation.");
    if(!result.reliable)flags.push("Thickness, section areas and volume were withheld because the edge/winding check failed or multiple shells were found. Check the model in your slicer/CAD tool.");
    if(load==="bending")flags.push("The selected axis is the beam's length (root to tip), not the direction you push. Actual bending stress also depends on the root, supports and load location.");
    if(load==="torsion")flags.push("Torsion uses printability ranking only. Shaft direction alone is insufficient to identify its critical tensile and shear stresses.");
    if(load==="compression")flags.push("Compression uses printability ranking only. Tall or thin features may buckle; that depends on their supports and applied load.");
    if(load==="unknown")flags.push("No loading specified: orientation ranking uses printability only. Choose pulling or beam bending to include a tensile layer-alignment preference.");
    return {walls,lineWidth,shellThickness:walls*lineWidth,layer,solidLayers,solidThickness:solidLayers*layer,
      infill,pattern:"Gyroid or cubic",material,why,flags};
  }

  function binarySTL(positions,orientation=null) {
    const count=positions.length/9,buffer=new ArrayBuffer(84+count*50),dv=new DataView(buffer);
    new Uint8Array(buffer).set(new TextEncoder().encode("STL Strength Analyzer - millimeters - geometry screening"));dv.setUint32(80,count,true);
    const rows=orientation?[orientation.u,orientation.v,orientation.n]:[[1,0,0],[0,1,0],[0,0,1]],lo=orientation?.lo||[0,0,0];
    for(let i=0;i<count;i++) {
      const vertices=[0,1,2].map(j=>rows.map((row,k)=>dot(row,pt(positions,i,j))-lo[k]));
      const n=unit(cross(sub(vertices[1],vertices[0]),sub(vertices[2],vertices[0]))),offset=84+i*50;
      for(let k=0;k<3;k++)dv.setFloat32(offset+k*4,n[k],true);
      for(let j=0;j<3;j++)for(let k=0;k<3;k++)dv.setFloat32(offset+12+(j*3+k)*4,vertices[j][k],true);
    }
    return buffer;
  }

  function demo() {
    // Counterclockwise outline: a narrow neck between two broad ends.
    const poly=[[-35,-12],[-12,-12],[-8,-2],[8,-2],[12,-12],[35,-12],[35,12],[12,12],[8,2],[-8,2],[-12,12],[-35,12]];
    const triangles=[],ids=poly.map((_,i)=>i),inside=(p,a,b,c)=>{
      const z=(u,v,w)=>(v[0]-u[0])*(w[1]-u[1])-(v[1]-u[1])*(w[0]-u[0]);
      return z(a,b,p)>=-1e-9&&z(b,c,p)>=-1e-9&&z(c,a,p)>=-1e-9;
    };
    while(ids.length>3) {
      let clipped=false;
      for(let i=0;i<ids.length;i++) {
        const a=ids[(i+ids.length-1)%ids.length],b=ids[i],c=ids[(i+1)%ids.length],p=poly[a],q=poly[b],r=poly[c];
        if((q[0]-p[0])*(r[1]-q[1])-(q[1]-p[1])*(r[0]-q[0])<=0)continue;
        if(ids.some(x=>x!==a&&x!==b&&x!==c&&inside(poly[x],p,q,r)))continue;
        triangles.push([a,b,c]);ids.splice(i,1);clipped=true;break;
      }
      if(!clipped)throw Error("Demo triangulation failed.");
    }
    triangles.push(ids.slice());const out=[],p=(i,z)=>[...poly[i],z],tri=(a,b,c)=>out.push(...a,...b,...c);
    for(const [a,b,c]of triangles){tri(p(a,6),p(b,6),p(c,6));tri(p(c,0),p(b,0),p(a,0));}
    for(let i=0;i<poly.length;i++){const j=(i+1)%poly.length;tri(p(i,0),p(j,0),p(j,6));tri(p(i,0),p(j,6),p(i,6));}
    return binarySTL(new Float64Array(out));
  }
  return {parseSTL,meshInfo,topology,buildBVH,rayHit,sampleThickness,sections,basis,analyze,rank,settings,binarySTL,demo,
    math:{add,sub,mul,dot,cross,norm,unit,clamp},MAX_FACES,MAX_BYTES};
})();
if(typeof module!=="undefined")module.exports=STLCore;
