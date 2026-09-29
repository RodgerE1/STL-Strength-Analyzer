"use strict";
// Analytic geometry cases: run with Node.js. No third-party dependencies.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const core=require("./analyzer_engine.js");
let checks=0;
const close=(a,b,tol=1e-5)=>assert.ok(Math.abs(a-b)<tol,`${a} != ${b}`);
function box(x,y,z,offset=[0,0,0]) {
  const p=[[0,0,0],[x,0,0],[x,y,0],[0,y,0],[0,0,z],[x,0,z],[x,y,z],[0,y,z]].map(v=>v.map((a,k)=>a+offset[k]));
  const indices=[[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]];
  return new Float64Array(indices.flatMap(t=>t.flatMap(i=>p[i])));
}
function test(name,fn){fn();checks++;console.log("PASS "+name);}
const analyze=p=>core.analyze(core.binarySTL(p));
const cube=analyze(box(10,10,10));
test("Closed cube has analytic volume, thickness and section areas",()=>{
  assert.equal(cube.reliable,true);close(cube.volume,1000);close(cube.thickness.minimum,10);
  for(const s of cube.sections)for(const v of s.values)close(v.area,100);
});
test("Thin plate is measured even with only twelve facets",()=>{
  const r=analyze(box(30,20,.6));close(r.thickness.minimum,.6);
  const o=core.rank(r,{load:"tension",axis:0,bed:[220,220,250]})[0];assert.ok(Math.abs(o.n[2])>.99);
  assert.ok(core.settings(r,{nozzle:.6,load:"tension"},o).flags.some(x=>x.includes("cannot enlarge")));
});
const demo=core.analyze(core.demo());
test("Necked bar has known 4 mm neck, 24 mm² neck area and 7680 mm³ volume",()=>{
  close(demo.thickness.minimum,4);close(demo.sections[0].minimum,24);close(demo.sections[0].peak,144);close(demo.volume,7680);
});
test("Tension recommendation keeps the stress axis within layer planes",()=>{
  for(let axis=0;axis<3;axis++){const o=core.rank(demo,{load:"tension",axis,bed:[220,220,250]})[0];assert.ok(o.alignment<.01);}
});
test("Compression is not falsely ranked as an across-layer tensile load",()=>{
  const r=core.rank(demo,{load:"compression",axis:0,bed:[220,220,250]});assert.ok(r.every(o=>!o.directional));
});
test("Open mesh withholds thickness, volume and sections",()=>{
  const r=analyze(box(10,10,10).slice(9));assert.ok(r.topology.boundary>0);assert.equal(r.volume,null);assert.equal(r.thickness.minimum,null);assert.equal(r.sections.length,0);
});
test("Disconnected shells withhold unreliable solid measurements",()=>{
  const r=analyze(new Float64Array([...box(10,10,10),...box(10,10,10,[25,0,0])]));assert.equal(r.topology.components,2);assert.equal(r.reliable,false);
});
test("Global inward winding does not change queried volume or thickness",()=>{
  const p=box(10,10,10);for(let i=0;i<p.length;i+=9)for(let k=0;k<3;k++){const a=p[i+3+k];p[i+3+k]=p[i+6+k];p[i+6+k]=a;}
  const r=analyze(p);close(r.volume,1000);close(r.thickness.minimum,10);close(r.sections[0].minimum,100);
});
test("ASCII STL parses; incomplete facets and nonfinite coordinates are rejected",()=>{
  const ascii=p=>"solid test\n"+Array.from({length:p.length/9},(_,i)=>"facet normal 0 0 0\nouter loop\n"+[0,1,2].map(j=>"vertex "+Array.from(p.slice(i*9+j*3,i*9+j*3+3)).join(" ")).join("\n")+"\nendloop\nendfacet\n").join("")+"endsolid test";
  const s=ascii(box(2,3,4)),buffer=new TextEncoder().encode(s).buffer,r=core.analyze(buffer);close(r.volume,24);assert.equal(r.format,"ASCII STL");
  assert.throws(()=>core.parseSTL(new TextEncoder().encode(s.replace("endfacet","")).buffer));
  assert.throws(()=>core.parseSTL(new TextEncoder().encode(s.replace("vertex 0 0 0","vertex NaN 0 0")).buffer));
});
test("Binary STL beginning with solid is still recognized as binary",()=>{
  const b=core.binarySTL(box(2,3,4));new Uint8Array(b).set(new TextEncoder().encode("solid misleading header"));assert.equal(core.parseSTL(b).format,"Binary STL");
});
test("Unit scale correctly changes dimensions, areas and volume",()=>{
  const r=core.analyze(core.binarySTL(box(1,2,3)),25.4);close(r.size[0],25.4);close(r.volume,6*25.4**3,.01);close(r.sections[0].minimum,6*25.4**2,.001);
  assert.throws(()=>core.parseSTL(core.demo(),0));assert.throws(()=>core.parseSTL(core.demo(),Infinity));
});
test("Orientation export preserves volume and sits at the bed origin",()=>{
  for(const o of demo.orientations){const r=core.analyze(core.binarySTL(demo.positions,o));close(r.volume,demo.volume,.01);for(let i=0;i<3;i++)close(r.size[i],o.size[i],.001);const mesh=core.meshInfo(core.parseSTL(core.binarySTL(demo.positions,o)).positions);assert.ok(mesh.lo.every(Number.isFinite));}
  const bytes=core.binarySTL(demo.positions,demo.orientations[2]),dv=new DataView(bytes);for(let axis=0;axis<3;axis++){let minimum=Infinity;for(let i=0;i<demo.count;i++)for(let j=0;j<3;j++)minimum=Math.min(minimum,dv.getFloat32(84+i*50+12+(j*3+axis)*4,true));close(minimum,0,.001);}
});
test("Build volume that needs a 90° bed turn gets a matching exported rotation",()=>{
  const r=analyze(box(100,30,5)),o=core.rank(r,{load:"tension",axis:0,bed:[40,120,20]}).find(x=>x.id==="Z1");assert.ok(o.fits);assert.equal(o.size[0],30);assert.equal(o.size[1],100);
  const exported=core.analyze(core.binarySTL(r.positions,o));close(exported.size[0],30);close(exported.size[1],100);
});
test("A very large part reports candidates that do not fit",()=>{
  const r=analyze(box(300,300,300));assert.ok(core.rank(r,{load:"unknown",bed:[220,220,250]}).every(o=>!o.fits));
});
test("Truncated binary, zero-area STL and non-manifold faces are handled",()=>{
  const b=core.demo();assert.throws(()=>core.parseSTL(b.slice(0,b.byteLength-5)));
  assert.throws(()=>analyze(new Float64Array(9)));
  const p=box(10,10,10),r=analyze(new Float64Array([...p,...p.slice(0,9)]));assert.ok(r.topology.nonmanifold>0);assert.equal(r.reliable,false);
});
test("Wall/layer presets adapt to nozzle and selected duty",()=>{
  let p=core.settings(demo,{nozzle:.4,load:"tension",duty:"demanding"},demo.orientations[0]);assert.equal(p.walls,6);close(p.layer,.16);assert.equal(p.solidLayers,10);
  p=core.settings(demo,{nozzle:.6,load:"compression",duty:"functional"},demo.orientations[0]);close(p.layer,.28);assert.equal(p.infill,40);assert.equal(p.solidLayers,5);
});
fs.mkdirSync(path.join(__dirname,"examples"),{recursive:true});
fs.writeFileSync(path.join(__dirname,"examples","Narrow_Neck_Bar.stl"),new Uint8Array(core.demo()));
fs.writeFileSync(path.join(__dirname,"examples","Thin_Plate_0.6mm.stl"),new Uint8Array(core.binarySTL(box(30,20,.6))));
console.log(`${checks} analytic geometry checks passed.`);
