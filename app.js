"use strict";
const $=id=>document.getElementById(id),fmt=(x,d=1)=>x===null||x===undefined?"—":Number(x).toLocaleString(undefined,{maximumFractionDigits:d,minimumFractionDigits:d});
const viewer=new STLViewer($("viewer"));
let result=null,ranked=[],selected=null,profile=null,worker=null,workerURL=null,currentBytes=null,currentName="",currentScale=1,busy=false;
const text=(id,value)=>$(id).textContent=value;
function inputs(){return {load:$("load").value,axis:Number($("axis").value),duty:$("duty").value,purpose:$("purpose").value,nozzle:Number($("nozzle").value),
  bed:["bedx","bedy","bedz"].map(id=>Number($(id).value)),enclosure:$("enclosure").checked,hotend:$("hotend").checked};}
function status(message,error=false){text("status",message);$("status").classList.toggle("error",error);}
function lock(flag){busy=flag;$("controls").classList.toggle("busy",flag);$("export").disabled=flag||!result;$("report").disabled=flag||!result;}
function units(){return $("units").value==="custom"?Number($("scale").value):Number($("units").value);}

function loadBytes(bytes,name,resetLoading=false) {
  const scale=units();if(!(scale>0)||!Number.isFinite(scale)){status("Enter a finite, positive STL scale.",true);return;}
  if(worker)worker.terminate();if(workerURL)URL.revokeObjectURL(workerURL);
  lock(true);status("Reading "+name+"…");
  if(resetLoading){$("load").value="unknown";$("axis").value="0";}
  const code=$("engine").textContent+`\nself.onmessage=e=>{try{const r=STLCore.analyze(e.data.buffer,e.data.scale,p=>postMessage({progress:p}));postMessage({result:r},[r.positions.buffer,r.normals.buffer]);}catch(error){postMessage({error:error.message});}};`;
  try{workerURL=URL.createObjectURL(new Blob([code],{type:"text/javascript"}));worker=new Worker(workerURL);}
  catch(e){lock(false);status("This browser cannot run the local analyzer worker. Try Chrome, Edge, or Opera with local file access. "+e.message,true);return;}
  worker.onmessage=e=>{
    if(e.data.progress){status(e.data.progress);return;}
    lock(false);
    if(e.data.error){status("Could not analyze "+name+": "+e.data.error+(result?" Previous model remains displayed.":""),true);return;}
    result=e.data.result;result.name=name;result.unitScale=scale;ranked=[];selected=null;
    currentBytes=bytes;currentName=name;currentScale=scale;lock(false);
    text("filename",name);text("dimensions",result.size.map(x=>fmt(x)).join(" × "));
    text("triangles",result.count.toLocaleString());text("meshcheck",result.reliable?"Closed single shell · edge check passed":`${result.topology.components} shell(s) · check model`);
    text("thickness",result.thickness.minimum===null?"Unavailable":fmt(result.thickness.minimum,2)+" mm");
    text("coverage",result.thickness.attempted?`${result.thickness.valid} of ${result.thickness.attempted} rays found opposing faces`:"Withheld for this mesh");
    text("volume",result.volume===null?"Unavailable":fmt(result.volume/1000,2)+" cm³");
    recompute();viewer.reset();drawSections();
    status(`${name} analyzed. ${result.removed?result.removed+" zero-area facets ignored. ":""}Choose loading and preview a print orientation.`);
    worker.terminate();worker=null;URL.revokeObjectURL(workerURL);workerURL=null;
  };
  worker.onerror=e=>{lock(false);status("Analysis worker failed: "+e.message,true);};
  const copy=bytes.slice(0);worker.postMessage({buffer:copy,scale},[copy]);
}

async function loadFile(file) {
  if(!file)return;
  if(file.size>STLCore.MAX_BYTES){status("STL exceeds the 32 MB limit. Simplify a copy first.",true);return;}
  try{loadBytes(await file.arrayBuffer(),file.name,true);}catch(e){status("Could not read file: "+e.message,true);}
}
$("open").onclick=()=>$("file").click();$("file").onchange=e=>{loadFile(e.target.files[0]);e.target.value="";};
$("demo").onclick=()=>{ $("units").value="1";$("scalefield").hidden=true;$("load").value="tension";$("axis").value="0";loadBytes(STLCore.demo(),"Example · narrow-neck bar.stl");};
document.addEventListener("dragover",e=>e.preventDefault());document.addEventListener("drop",e=>{e.preventDefault();loadFile(e.dataTransfer.files[0]);});

function recompute() {
  const i=inputs(),isBend=i.load==="bending";
  text("axislabel",isBend?"Beam length in original STL":i.load==="torsion"?"Shaft axis in original STL":"Load axis in original STL");
  text("loadhint",{unknown:"Ranking uses printability until loading is specified.",tension:"Select the direction the part is pulled apart.",bending:"Select the beam's root-to-tip direction, not the direction you push.",compression:"Printability ranking; buckling and restraint need further assessment.",torsion:"Printability ranking; critical shear stress cannot be inferred from the shaft axis alone."}[i.load]);
  $("axis").disabled=i.load==="unknown";
  if(!result)return;
  if(i.bed.some(x=>!Number.isFinite(x)||x<20||x>5000)){status("Enter usable build dimensions from 20 to 5,000 mm.",true);return;}
  ranked=STLCore.rank(result,i);selected=ranked[0];updateSelected();
  text("rankingnote",selected.directional?"Ranked by tensile layer alignment and printability. A low alignment concern does not establish a safe load.":"Ranked by bed contact, steep faces and height. No tensile alignment preference is applied for this loading.");
  renderOrientations();drawSections();
}

function renderOrientations() {
  const body=$("orientations");body.replaceChildren();
  for(const o of ranked) {
    const tr=document.createElement("tr");tr.className=o.id===selected.id?"selected":"";
    const concern=o.directional?(o.alignment>.8?"High · crosses layers":o.alignment>.3?"Moderate · angled":"Low · within layers"):"Not assessed";
    for(const value of [o.label+(o.id===ranked[0].id?" · recommended":""),o.size.map(x=>fmt(x)).join(" × ")+(o.fits?"":" · does not fit"),fmt(o.contactRatio*100,0)+"%",fmt(o.overhangFraction*100,1)+"%",concern]) {
      const td=document.createElement("td");td.textContent=value;tr.appendChild(td);
    }
    const cell=document.createElement("td"),button=document.createElement("button");button.textContent=o.id===selected.id?"Selected":"Preview";
    button.onclick=()=>{selected=o;updateSelected();renderOrientations();};cell.appendChild(button);tr.appendChild(cell);body.appendChild(tr);
  }
}

function findings() {
  const i=inputs(),p=profile,o=selected,t=result.topology,notes=[];
  if(!result.reliable)notes.push(`Mesh check: ${t.boundary} boundary edges, ${t.nonmanifold} non-manifold edges, ${t.winding} inconsistent shared edges, ${t.components} shell(s). The edge check is approximate. Steep-face estimates assume outward winding and are less reliable on a defective mesh.`);
  if(o.directional) {
    const angle=Math.acos(STLCore.math.clamp(o.alignment,0,1))*180/Math.PI;
    notes.push(`The selected tensile direction is ${fmt(angle,0)}° from print +Z. ${o.alignment>.8?"It pulls mostly across layer bonds; consider another orientation.":o.alignment>.3?"It has an across-layer component; inspect the loaded feature.":"It lies mostly within the layers, which reduces the tendency to pull layers apart."}`);
  }else notes.push("Print +Z is the layer-stacking direction. Tensile loads along it are generally more prone to layer separation; this is not a compression or torsion strength prediction.");
  if(result.sections.length) {
    const relevant=i.load==="unknown"?result.sections.filter(s=>s.ratio<.55):[result.sections[i.axis]];
    for(const s of relevant) {
      if(s.ratio<.55)notes.push(`Along original ${"XYZ"[s.axis]}, the narrow interior section is ${fmt(s.minimum,1)} mm², ${fmt(s.ratio*100,0)}% of a larger section. Check whether this neck carries the load; consider a wider web or smoother transition.`);
    }
  }
  if(result.thickness.minimum!==null)notes.push(`Normal-ray samples range down to ${fmt(result.thickness.minimum,2)} mm. Sampling does not prove the minimum wall thickness everywhere.`);
  notes.push(...p.flags);
  if(result.removed)notes.push(`${result.removed} zero-area facets were ignored. Export includes the remaining facets.`);
  if(result.count>60000)notes.push("The view shows a subset of triangles. Geometry checks and STL export use all loaded triangles.");
  return notes;
}

function updateSelected() {
  if(!result||!selected)return;const i=inputs();profile=STLCore.settings(result,i,selected);
  text("orientationtitle",selected.label);
  const n=selected.n.map(x=>fmt(x,2)).join(", "),best=selected.id===ranked[0].id;
  text("orientationwhy",`${best?"Recommended candidate":"Manually selected candidate"} · print size ${selected.size.map(x=>fmt(x)).join(" × ")} mm. Build-up vector in the original STL: [${n}].`);
  text("wallcount",profile.walls);text("infill",profile.infill+"%");text("layerheight",fmt(profile.layer,2)+" mm");text("material",profile.material);
  text("settingsdetail",`Approx. ${fmt(profile.shellThickness,2)} mm wall shell where geometry permits (${fmt(profile.lineWidth,2)} mm extrusion width). Top / bottom: ${profile.solidLayers} layers each, ${fmt(profile.solidThickness,2)} mm. Set temperatures and cooling from your calibrated filament profile.`);
  text("materialwhy",profile.why);
  $("capability").hidden=!(profile.material==="ASA"&&(!i.enclosure||!i.hotend));
  text("capability","ASA needs a suitable enclosure and a hotend rated for its print temperature. Confirm those capabilities on your Ender‑3 before using this material.");
  const list=$("findings");list.replaceChildren();for(const note of findings()){const li=document.createElement("li");li.textContent=note;list.appendChild(li);}
  viewer.mode=$("viewmode").value;viewer.arrows=$("arrows").checked;viewer.axis=i.axis;viewer.load=i.load;viewer.lineWidth=profile.lineWidth;viewer.layer=profile.layer;viewer.setModel(result,selected);
  text("viewlabel",selected.label+" · drag to rotate · wheel to zoom");
  updateLegend();
}

function updateLegend() {
  const mode=$("viewmode").value,legend=$("legend");legend.replaceChildren();
  const items=mode==="thickness"?[["#c4a5ff",`Under ${fmt(2*viewer.lineWidth,2)} mm · <2 lines`],["#ffc26a",`Under ${fmt(4*viewer.lineWidth,2)} mm · <4 lines`],["#69d5ee","4+ lines"],[null,"Dots = measured samples; gray = unsampled"]]:mode==="layers"?[["#a9b8cb",`Illustrative planes at ${fmt(viewer.layer,2)} mm; not sliced toolpaths`]]:mode==="overhang"?[["#ffc26a","Steep downward faces (>45°), including bed faces"],[null,"Bed-contact faces do not count in the table's steep-face estimate"]]:[[null,"Full shape · print +Z arrow shows how the layers stack"]];
  for(const [color,label]of items){const span=document.createElement("span");if(color){const dot=document.createElement("i");dot.className="dot";dot.style.background=color;span.appendChild(dot);}span.appendChild(document.createTextNode(label));legend.appendChild(span);}
  if(!viewer.gl&&mode==="layers")text("viewerhint","Layer bands require WebGL. Direction arrows show print +Z in this simplified view.");
  else text("viewerhint","Purple arrow: print +Z (layer stacking). Cyan double arrow: selected original axis.");
}

function drawSections() {
  const canvas=$("sectionchart"),ctx=canvas.getContext("2d"),ratio=Math.min(devicePixelRatio||1,2),w=canvas.clientWidth,h=155;
  canvas.width=Math.max(1,w*ratio);canvas.height=h*ratio;ctx.scale(ratio,ratio);ctx.clearRect(0,0,w,h);
  const table=$("sections");table.replaceChildren();
  if(!result?.sections.length){ctx.fillStyle="#a9b8cb";ctx.font="13px Segoe UI";ctx.fillText("Section measurements unavailable for this mesh.",15,60);return;}
  const left=45,right=20,top=15,bottom=27,colors=["#69d5ee","#ffc26a","#c4a5ff"];
  let max=0;for(const s of result.sections)for(const v of s.values)max=Math.max(max,v.area);max=max||1;
  ctx.font="11px Segoe UI";ctx.lineWidth=1;
  for(let k=0;k<=3;k++){const y=top+(h-top-bottom)*k/3;ctx.strokeStyle="#354353";ctx.beginPath();ctx.moveTo(left,y);ctx.lineTo(w-right,y);ctx.stroke();ctx.fillStyle="#a9b8cb";ctx.fillText(fmt(max*(1-k/3),0),1,y+4);}
  ctx.fillText("0%",left,h-8);ctx.fillText("Position along each original axis",Math.max(left,w/2-90),h-8);ctx.fillText("100%",w-right-28,h-8);
  for(const s of result.sections) {
    ctx.strokeStyle=colors[s.axis];ctx.lineWidth=2;ctx.beginPath();for(let j=0;j<s.values.length;j++){const v=s.values[j],x=left+v.fraction*(w-left-right),y=top+(1-v.area/max)*(h-top-bottom);j?ctx.lineTo(x,y):ctx.moveTo(x,y);}ctx.stroke();
    const row=document.createElement("tr");for(const [k,value]of ["XYZ"[s.axis],fmt(s.minimum,1)+" mm²",fmt(s.ratio*100,0)+"%",s.ratio<.55?"Narrow section; inspect load path":"No large central area drop sampled"].entries()){const td=document.createElement("td");td.textContent=value;if(k===0){td.style.color=colors[s.axis];td.style.fontWeight="700";}row.appendChild(td);}table.appendChild(row);
  }
}

function download(bytes,name,mime){const url=URL.createObjectURL(new Blob([bytes],{type:mime})),a=document.createElement("a");a.href=url;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}
function basename(){return (result?.name||"model").replace(/\.stl$/i,"").replace(/[<>:"/\\|?*·]/g,"_");}
function reportText() {
  if(!result||!selected)return "";
  const i=inputs(),p=profile,axis="XYZ"[i.axis];
  const sections=result.sections.map(s=>`${"XYZ"[s.axis]}: ${fmt(s.minimum,2)} mm² interior minimum; ${fmt(s.ratio*100,1)}% of 90th-percentile interior area.`);
  const orientationLines=ranked.map(o=>`${o.id===selected.id?"SELECTED":"        "} ${o.label}; size ${o.size.map(x=>fmt(x,2)).join(" x ")} mm; flat contact ${fmt(o.contactRatio*100,1)}%; steep surface ${fmt(o.overhangFraction*100,1)}%; ${o.fits?"fits":"does not fit"}; ${o.directional?`absolute tensile axis/build-up dot product ${fmt(o.alignment,3)}`:"tensile alignment not assessed"}`);
  return ["STL STRENGTH ANALYZER 1.0",new Date().toLocaleString(),"",`Model: ${result.name}`,`Millimeters per original STL unit: ${result.unitScale}`,`Original size: ${result.size.map(x=>fmt(x,2)).join(" x ")} mm`,
    `Triangle count: ${result.count}; ignored zero-area facets: ${result.removed}`,`Mesh: ${JSON.stringify(result.topology)}`,`Solid-volume estimate: ${fmt(result.volume,2)} mm³`,
    `Thickness rays: ${result.thickness.valid}/${result.thickness.attempted} valid; sampled minimum ${fmt(result.thickness.minimum,3)} mm`,"",
    `Loading: ${i.load}; selected original axis: ${axis}${i.load==="bending"?" (beam length, not push direction)":""}`,`Print profile: ${i.duty}; material priority: ${i.purpose}`,
    `Build volume: ${i.bed.join(" x ")} mm; nozzle ${i.nozzle} mm; enclosure: ${i.enclosure}; hotend temperature capability: ${i.hotend}`,"",
    `Selected orientation: ${selected.label}`,`Original coordinate to print coordinate rows (rotation matrix):`,...[selected.u,selected.v,selected.n].map(row=>row.map(x=>fmt(x,6)).join(", ")),
    "Export also translates the rotated mesh bounding box minimum to [0,0,0]. Its STL coordinates are millimeters.","",
    "STARTING PRINT SETTINGS",`Walls / perimeters: ${p.walls}; estimated width ${fmt(p.lineWidth,3)} mm; shell ${fmt(p.shellThickness,3)} mm where geometry permits`,
    `Infill: ${p.infill}% ${p.pattern}; layer height ${p.layer} mm; top AND bottom ${p.solidLayers} layers each (${fmt(p.solidThickness,2)} mm)`,
    `Material: ${p.material}. ${p.why}`,"Temperatures/cooling: use the calibrated filament profile and your hotend rating.","","FINDINGS",...findings().map(x=>"- "+x),"","CROSS-SECTIONS (CENTRAL 15–85%)",...sections,"","ORIENTATION CANDIDATES",...orientationLines,"",
    "METHOD AND LIMITS","Geometry screening only: no FEA, stress tensor, safety factor or failure-load prediction.",
    "The loading is user supplied. Pulling/beam bending prefer longitudinal tensile stress within layers. Other loading ranks printability only.",
    "Thickness uses sampled face-center normal rays to opposing surfaces. Not a guaranteed global minimum. Section areas use 37 planes per axis.",
    "Edge/winding checks do not validate self-intersections. Multiple/open/inconsistent shells have thickness, volume and section results withheld.",
    "Bed contact, steep faces and ranking are heuristic. Bridges/cavities can be included in steep faces; candidate rotations are not exhaustive.",
    "Fit allows a 90-degree bed rotation; leave extra room for supports/brims. Verify orientation and toolpaths in your slicer.",
    "The exact print presets and ranking weights are this app's choices, not certified performance data.","","REFERENCES (checked September 29, 2026)",
    "https://help.prusa3d.com/article/modeling-with-3d-printing-in-mind_164135","https://help.prusa3d.com/article/layers-and-perimeters_1748","https://help.prusa3d.com/article/infill_42","https://help.prusa3d.com/article/petg_2059","https://help.prusa3d.com/article/asa_1809",""].join("\r\n");
}
$("export").onclick=()=>{if(!result||busy)return;download(STLCore.binarySTL(result.positions,selected),basename()+"_oriented_mm.stl","model/stl");status("Saved a new oriented STL in millimeters. Verify it in your slicer.");};
$("report").onclick=()=>{if(!result||busy)return;download(reportText(),basename()+"_strength_report.txt","text/plain;charset=utf-8");status("Saved the report with your selected orientation and print settings.");};
for(const id of ["load","axis","duty","purpose","nozzle","enclosure","hotend","bedx","bedy","bedz"])$(id).addEventListener("change",()=>{if(!busy){recompute();if(result)status("Recommendations updated from the current inputs.");}});
$("units").onchange=()=>{$("scalefield").hidden=$("units").value!=="custom";if(currentBytes)loadBytes(currentBytes,currentName);};
$("scale").onchange=()=>{if(currentBytes&&$("units").value==="custom")loadBytes(currentBytes,currentName);};
$("viewmode").onchange=()=>{viewer.mode=$("viewmode").value;updateLegend();viewer.draw();};
$("arrows").onchange=()=>{viewer.arrows=$("arrows").checked;viewer.draw();};$("home").onclick=()=>viewer.reset();
$("original").onclick=()=>{if(!result)return;selected=ranked.find(o=>o.id==="Z1");updateSelected();renderOrientations();};
window.addEventListener("resize",drawSections);
window.STLAnalyzer={getResult:()=>result,getSelected:()=>selected,getSettings:()=>profile,reportText,loadBytes,recompute};
$("demo").click();
