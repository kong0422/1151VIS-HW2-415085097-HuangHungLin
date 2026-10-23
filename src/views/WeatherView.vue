<template>
  <LayoutHeader
    :env="env" :page_title="page_title"
    :client="client_info"
  />

  <div class="container mt-4 mx-6">
    <h1>台灣縣市氣象色塊圖</h1>
    <div class="seg">
      <template v-for="(m,k) in METRICS" :key="k">
        <button v-if="!m.tipOnly" :class="{on:metric===k}" @click="metric=k">{{ m.label }}</button>
      </template>
    </div>
    <div class="status" :class="{err:failed}">{{ status }}</div>
    <div v-if="failed" class="card" style="font-size:13px;margin-bottom:8px">
      自動載入失敗時，可自行選擇縣市 TopoJSON / GeoJSON 檔案：
      <input type="file" accept=".json,.topojson,.geojson" @change="onFile">
    </div>
    <div class="ctl">
      <label><input type="checkbox" v-model="showLabels"> 顯示縣市名稱與數值</label>
      <label><input type="checkbox" v-model="showIcons"> 顯示天氣圖示</label>
      <!-- <input type="text" v-model="apiKey" placeholder="CWA 授權碼"> -->
      <button @click="loadLive">載入即時資料</button>
      <span>{{ M.label }}資料：{{ sources[metric] }}（{{ records.length }} 筆）</span>
    </div>
    <div style="font-size:12px;color:#b3261e;min-height:16px;white-space:pre-line">{{ msg }}</div>
    <div class="row">
      <div class="card" ref="cardEl" style="position:relative">
        <div class="bar-tools" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:6px">
          <button class="tgl" :class="{on:brushMode}" @click="brushMode=!brushMode">框選模式：{{ brushMode ? '開' : '關' }}</button>
          <button v-if="picked.length && !popupOpen" @click="popupOpen=true">顯示長條圖</button>
          <button v-if="picked.length" @click="clearPicked">清除選取（{{ picked.length }}）</button>
          <span style="font-size:12px;color:#6b7685">{{ brushMode ? '在地圖上拖曳畫出矩形，選取縣市；滾輪仍可縮放' : '開啟後可拖曳框選縣市，放開滑鼠會跳出長條圖視窗' }}</span>
        </div>
        <div class="name">{{ info || '滑鼠移到縣市上查看氣溫、紫外線、降雨機率（滾輪縮放、拖曳平移）' }}</div>
        <div class="mapbox">
          <svg ref="svg" viewBox="0 0 700 800"></svg>
          <div class="legend-box"><svg ref="legend" viewBox="0 0 90 235" style="background:none;cursor:default"></svg></div>
        </div>
        <div v-if="tip" class="tip" :style="{left:tip.x+'px',top:tip.y+'px',transform:tip.flip?'translate(-100%,0)':'none'}">
          <div class="tn">{{ tip.name }}</div>
          <div v-if="tip.wx" class="tr"><span>天氣</span><b>{{ tip.wx.icon }} {{ tip.wx.text }}</b></div>
          <div v-for="r in tip.rows" :key="r.k" class="tr" :class="{cur:r.k===metric}">
            <span><i class="dot" :style="{background:r.color}"></i>{{ r.label }}</span><b>{{ r.text }}</b>
          </div>
        </div>
      </div>
      <div class="card">
        <b style="font-size:14px">{{ M.title }}</b>
        <ol>
          <li v-for="r in rows" :key="r.name" :class="{on:sel===r.name}" @click="sel=r.name">
            <span><i class="dot" :style="r.avg==null?{}:{background:color(r.avg)}"></i>{{ r.icon }} {{ r.name }}</span>
            <b>{{ r.avg==null ? '—' : M.short(r.avg) }}</b>
          </li>
        </ol>
      </div>
    </div>
    <!-- 框選後的長條圖快顯視窗（可拖曳標題列移動） -->
    <div v-show="popupOpen" ref="popup" class="popup" role="dialog" aria-label="選取縣市長條圖"
        :style="popupPos?{left:popupPos.x+'px',top:popupPos.y+'px'}:{right:'16px',bottom:'16px'}">
      <div class="popup-head" @pointerdown="startDrag">
        <b style="font-size:16px">選取縣市長條圖（{{ picked.length }}）</b>
        <span style="display:flex;align-items:center;gap:6px">
          <label style="font-size:14px">指標
            <select v-model="chartMetric"><option v-for="(m,k) in METRICS" :key="k" :value="k">{{ m.label }}</option></select>
          </label>
          <button class="popup-x" @click="popupOpen=false" aria-label="關閉">×</button>
        </span>
      </div>
      <svg ref="bars" viewBox="0 0 600 60" style="background:none;cursor:default"></svg>
    </div>
  </div>

  <LayoutFooter
    :env="env"
    :client="client_info"
    :page_title="page_title"
  />
</template>

<script setup>
import '../assets/weather.css';
import LayoutHeader from '@/components/LayoutHeader.vue';
import LayoutFooter from '@/components/LayoutFooter.vue';

import { createApp, ref, computed, watch, onMounted } from 'vue';
import * as d3 from 'd3';
import * as topojson from 'topojson-client';
import Papa from 'papaparse';
</script>

<script>

// 測試用預設授權碼（瀏覽器若已存過其他授權碼，以瀏覽器內的為準；分享檔案前請先清空）
const URLS = [
  "https://cdn.jsdelivr.net/npm/taiwan-atlas/counties-10t.json",
  "https://unpkg.com/taiwan-atlas/counties-10t.json"
];

// ---- 指標設定 ----
const uvLevels = [
  {from:0, label:"低量級", color:"#4caf50"}, {from:3, label:"中量級", color:"#fdd835"},
  {from:6, label:"高量級", color:"#fb8c00"}, {from:8, label:"過量級", color:"#e53935"},
  {from:11, label:"危險級", color:"#8e24aa"}
];
const uvLevel = v => [...uvLevels].reverse().find(l => v >= l.from);
const METRICS = {
  temp: { label:"氣溫", title:"縣市平均氣溫", showN:true,
    color:d3.scaleSequential(t=>d3.interpolateRdYlBu(1-t)).domain([0,35]).clamp(true),
    domain:[0,35], ticks:[0,5,10,15,20,25,30,35], tickFmt:d=>d+"°",
    short:v=>v.toFixed(1)+"°", full:v=>v.toFixed(1)+"°C" },
  // 日照時數：色階上限依目前資料自動調整（見 computed.sunMax），不論讀數是 0–1（每小時）還是 0–12（累積）都看得出差異
  sun: { label:"日照時數", title:"縣市平均日照時數", showN:true, dynamic:true,
    color:(v,max=12)=>d3.interpolateYlOrBr(.1+.8*Math.min(Math.max(v/max,0),1)),
    domain:[0,12], tickFmt:d=>d+"h",
    short:v=>v.toFixed(1)+"h", full:v=>v.toFixed(1)+" 小時" },
  rain: { label:"降雨機率", title:"縣市降雨機率", showN:false,
    color:d3.scaleSequential(t=>d3.interpolateBlues(.08+.92*t)).domain([0,100]).clamp(true),
    domain:[0,100], ticks:[0,20,40,60,80,100], tickFmt:d=>d+"%",
    short:v=>Math.round(v)+"%", full:v=>Math.round(v)+"%" },
  // 以下兩項目前只顯示在提示窗（tipOnly），不出現在切換按鈕
  uv: { label:"紫外線", title:"縣市平均紫外線指數", showN:true, tipOnly:true,
    color:v=>uvLevel(v).color,
    bands:uvLevels,
    short:v=>v.toFixed(1), full:v=>`指數 ${v.toFixed(1)}（${uvLevel(v).label}）` },
  acc: { label:"累積雨量", title:"縣市平均累積雨量", showN:true, tipOnly:true,
    color:d3.scaleSequential(t=>d3.interpolateBlues(.08+.92*t)).domain([0,100]).clamp(true),
    domain:[0,100], ticks:[0,25,50,75,100], tickFmt:d=>d+"mm",
    short:v=>v.toFixed(1)+"mm", full:v=>v.toFixed(1)+" mm" }
};

// 天氣現象文字 → 圖示（適用觀測的「晴」「陰有雨」與預報的「多雲時晴」「陰短暫雨」等）
const wxIcon = t => {
  if(!t) return "";
  if(/雷/.test(t)) return "⛈️";
  if(/雪/.test(t)) return "🌨️";
  if(/雨/.test(t)) return /晴|多雲/.test(t) ? "🌦️" : "🌧️";
  if(/霧/.test(t)) return "🌫️";
  if(/陰/.test(t)) return "☁️";
  if(/晴/.test(t)) return /多雲/.test(t) ? "🌤️" : "☀️";
  if(/多雲/.test(t)) return "⛅";
  return "🌡️";
};

// ---- 預設範例資料（示意值，非即時）----
// 開啟頁面時先顯示這組資料；內嵌資料或即時資料載入成功後，會逐項取代對應的指標。
const T = [
["基隆","基隆市",24.8],["臺北","臺北市",27.1],["陽明山","臺北市",19.8],["板橋","新北市",26.9],["桃園","桃園市",26.0],
["新竹","新竹縣",26.2],["新竹市區","新竹市",26.3],["苗栗","苗栗縣",26.4],["臺中","臺中市",27.4],["梧棲","臺中市",26.1],
["員林","彰化縣",27.1],["日月潭","南投縣",22.3],["玉山","南投縣",6.2],["斗六","雲林縣",27.3],["阿里山","嘉義縣",14.6],
["嘉義","嘉義市",27.8],["臺南","臺南市",28.3],["高雄","高雄市",29.1],["恆春","屏東縣",28.6],["大武","臺東縣",28.2],
["臺東","臺東縣",27.9],["成功","臺東縣",27.2],["蘭嶼","臺東縣",28.0],["花蓮","花蓮縣",26.5],["宜蘭","宜蘭縣",25.7],
["蘇澳","宜蘭縣",25.4],["澎湖","澎湖縣",27.5],["金門","金門縣",26.0],["馬祖","連江縣",23.8]
].map(([name,county,v])=>({name,county,v}));
const byCounty = o => Object.entries(o).map(([county,v])=>({name:county,county,v}));
// 紫外線、累積雨量、日照時數的範例：與氣溫範例使用同一批測站（山區測站可個別微調）
const perStation = (base, adj={}) => T.map(s=>({name:s.name,county:s.county,v:adj[s.name]!==undefined?adj[s.name]:base[s.county]}));
const UV = perStation({基隆市:6,臺北市:7,新北市:7,桃園市:7,新竹縣:8,新竹市:8,苗栗縣:8,臺中市:9,彰化縣:9,南投縣:8,雲林縣:9,嘉義縣:9,嘉義市:9,臺南市:10,高雄市:10,屏東縣:10,宜蘭縣:5,花蓮縣:7,臺東縣:8,澎湖縣:11,金門縣:7,連江縣:5}, {玉山:11,阿里山:10,日月潭:8,陽明山:6});
const RAIN = byCounty({基隆市:70,臺北市:60,新北市:60,桃園市:50,新竹縣:40,新竹市:40,苗栗縣:30,臺中市:20,彰化縣:20,南投縣:30,雲林縣:20,嘉義縣:20,嘉義市:20,臺南市:10,高雄市:10,屏東縣:20,宜蘭縣:80,花蓮縣:60,臺東縣:40,澎湖縣:10,金門縣:30,連江縣:50});
const ACC = perStation({基隆市:12.5,臺北市:8.0,新北市:10.5,桃園市:5.0,新竹縣:2.5,新竹市:2.0,苗栗縣:1.0,臺中市:0.5,彰化縣:0,南投縣:3.0,雲林縣:0,嘉義縣:1.5,嘉義市:0,臺南市:0,高雄市:0,屏東縣:0.5,宜蘭縣:25.0,花蓮縣:6.0,臺東縣:2.0,澎湖縣:0,金門縣:0.5,連江縣:4.0});
const SUN = perStation({基隆市:1.5,臺北市:3.0,新北市:3.2,桃園市:4.0,新竹縣:5.5,新竹市:5.8,苗栗縣:6.5,臺中市:8.0,彰化縣:8.5,南投縣:6.0,雲林縣:8.8,嘉義縣:8.0,嘉義市:8.9,臺南市:9.5,高雄市:9.8,屏東縣:9.0,宜蘭縣:0.8,花蓮縣:4.5,臺東縣:6.0,澎湖縣:10.2,金門縣:6.5,連江縣:2.0});
const WX = Object.entries({基隆市:"陰有雨",臺北市:"多雲",新北市:"多雲",桃園市:"多雲",新竹縣:"晴時多雲",新竹市:"晴時多雲",苗栗縣:"晴",臺中市:"晴",彰化縣:"晴",南投縣:"多雲",雲林縣:"晴",嘉義縣:"晴",嘉義市:"晴",臺南市:"晴",高雄市:"晴",屏東縣:"晴",宜蘭縣:"陰有雨",花蓮縣:"陰",臺東縣:"多雲",澎湖縣:"晴",金門縣:"多雲",連江縣:"陰"})
  .map(([county,text])=>({name:county,county,text}));
const SAMPLE_SRC = "範例資料（示意值，非即時）";

export default {
  inject: ['getMyData', 'setMyData'],
  props: ['env', 'page_title', 'client_info', 'API_KEY', 'API_URL'],
  data(){
    return {
      METRICS: Object.freeze(METRICS),          // 指標設定（凍結，避免被 Vue 代理）
      urls: URLS,                               // 縣市 TopoJSON 來源
      refreshMs: 600000,                        // 即時資料更新間隔：10 分鐘
      status: "載入地圖中…", failed: false, msg: "", info: "", tip: null,
      metric: "temp", showLabels: true, showIcons: true,
      brushMode: false, picked: [], chartMetric: "temp",   // 框選模式、已框選的縣市、長條圖指標
      popupOpen: false, popupPos: null,                    // 長條圖快顯視窗：是否開啟、被拖曳後的位置（null＝預設右下角）
      apiKey: this.API_KEY, sel: "", countyNames: [],
      datasets: {temp:T, uv:UV, rain:RAIN, acc:ACC, sun:SUN},
      weather: WX,                              // 天氣現象（文字），例如「多雲」「陰有雨」
      sources: {temp:SAMPLE_SRC, uv:SAMPLE_SRC, rain:SAMPLE_SRC, acc:SAMPLE_SRC, sun:SAMPLE_SRC, weather:SAMPLE_SRC}
    };
  },

  computed: {
    M(){ return this.METRICS[this.metric]; },
    records(){ return this.datasets[this.metric]; },
    hasData(){ return Object.values(this.datasets).some(a=>a.length); },
    // 各縣市的天氣現象（同縣市多站時取最常出現者）
    weatherMap(){
      const g=new Map();
      for(const w of this.weather){const c=this.norm(w.county);const m=g.get(c)||new Map();m.set(w.text,(m.get(w.text)||0)+1);g.set(c,m);}
      const out=new Map();
      g.forEach((m,c)=>{const text=[...m.entries()].sort((a,b)=>b[1]-a[1])[0][0];out.set(c,{text,icon:wxIcon(text)});});
      return out;
    },
    // 各縣市五項指標的平均值
    allAvg(){
      const out={};
      for(const k in this.METRICS){
        const m=new Map();
        for(const s of this.datasets[k]){const c=this.norm(s.county);const o=m.get(c)||{sum:0,n:0};o.sum+=s.v;o.n++;m.set(c,o);}
        const r=new Map(); m.forEach((o,c)=>r.set(c,{avg:o.sum/o.n,n:o.n})); out[k]=r;
      }
      return out;
    },
    avgMap(){ return this.allAvg[this.metric]; },
    // 日照時數色階上限：讀數 ≤1（每小時）→ 1；否則取 2 的倍數（例如累積 9.3 → 10）
    sunMax(){
      let mx=0; this.allAvg.sun.forEach(a=>{ if(a.avg>mx) mx=a.avg; });
      return mx<=1.0001?1:Math.max(2,Math.ceil(mx/2)*2);
    },
    rows(){
      const names=this.countyNames.length?this.countyNames:[...new Set(this.records.map(s=>s.county))];
      return names.map(n=>{const a=this.avgMap.get(this.norm(n)),w=this.wxOf(n);return{name:n,avg:a?a.avg:null,icon:w?w.icon:""};})
        .sort((x,y)=>(y.avg??-999)-(x.avg??-999));
    }
  },

  watch: {
    avgMap(){ this.paint(); },
    showLabels(){ this.paint(); },
    showIcons(){ this.paint(); },
    weatherMap(){ this.paint(); },
    metric(){ this.info=""; this.drawLegend(); this.chartMetric=this.metric; },
    sunMax(){ this.drawLegend(); this.drawBars(); },
    brushMode(){ this.updateBrushMode(); },
    picked(){ this.highlightPicked(); this.drawBars(); if(!this.picked.length) this.popupOpen=false; },
    chartMetric(){ this.drawBars(); },
    allAvg(){ this.drawBars(); },
    sel(){ if(this.g) this.g.selectAll(".county").classed("on",d=>this.nameOf(d)===this.sel); }
  },

  // 初始化：讀取授權碼、立即抓即時資料、設定定時更新
  // （非響應式的 D3 物件放在這裡，不放進 data，避免 selection 被 Vue 代理）
  created(){
    this.g=null; this.labelG=null; this.iconG=null; this.curK=1; this.timer=null;
    this.zoomT=d3.zoomIdentity; this.centroids=[]; this.brush=null; this.brushG=null; this.drag=null;
    try{ this.apiKey=localStorage.getItem("cwa_key")||this.API_KEY; }catch(e){}
    this.loadLive(); 
    // this.timer=setInterval(()=>{ if(auto()) this.loadLive(); ; }, this.refreshMs);
    this.timer=setInterval(()=>{ this.loadLive(); }, this.refreshMs);
  },
  // 需要 DOM（svg / 圖例）的動作要等掛載後才能做
  mounted(){ this.drawLegend(); this.drawBars(); this.loadMap(); },
  beforeUnmount(){ clearInterval(this.timer); window.removeEventListener("pointermove",this.onDrag); window.removeEventListener("pointerup",this.endDrag); },

  methods: {
    // ---- 工具 ----
    color(v){ return this.colorOf(this.metric,v); },
    colorOf(k,v){ const m=this.METRICS[k]; return m.dynamic?m.color(v,this.sunMax):m.color(v); },
    norm(s){ return (s||"").replace(/台/g,"臺"); },
    nameOf(f){ const p=f.properties||{}; return p.COUNTYNAME||p.name||p.NAME||p.county||"(未命名)"; },
    firstCoord(g){ let c=g.coordinates; while(Array.isArray(c[0])) c=c[0]; return c; },
    rewind(f){
      if(d3.geoArea(f)<=2*Math.PI) return f;
      const g=f.geometry;
      if(g.type==="Polygon") g.coordinates=g.coordinates.map(r=>r.slice().reverse());
      else if(g.type==="MultiPolygon") g.coordinates=g.coordinates.map(pl=>pl.map(r=>r.slice().reverse()));
      return f;
    },
    toFeatures(data){
      let fc=data;
      if(data.type==="Topology"){
        const key=data.objects.counties?"counties":Object.keys(data.objects)[0];
        fc=topojson.feature(data,data.objects[key]);
      }
      const feats=fc.type==="FeatureCollection"?fc.features:[fc];
      if(!feats.length) throw new Error("檔案內沒有任何圖形");
      return feats;
    },

    wxOf(n){ return this.weatherMap.get(this.norm(n))||null; },

    // ---- 提示窗 ----
    tipRows(n){
      return Object.keys(this.METRICS).map(k=>{
        const m=this.METRICS[k], a=this.allAvg[k].get(this.norm(n));
        return{k,label:m.label,color:a?this.colorOf(k,a.avg):"#d9dee6",
          text:a?m.full(a.avg)+(m.showN&&a.n>1?`（${a.n} 站平均）`:""):"無資料"};
      });
    },
    showTip(e,d){
      const b=this.$refs.cardEl.getBoundingClientRect(), x=e.clientX-b.left, y=e.clientY-b.top, flip=x>b.width*0.55;
      this.tip={name:this.nameOf(d),wx:this.wxOf(this.nameOf(d)),rows:this.tipRows(this.nameOf(d)),x:flip?x-14:x+14,y:y+14,flip};
    },
    describe(f){
      const n=this.nameOf(f), a=this.avgMap.get(this.norm(n)), m=this.M, w=this.wxOf(n), ic=w?w.icon+" ":"";
      if(!a) return `${ic}${n}　無${m.label}資料`;
      return `${ic}${n}　${m.label} ${m.full(a.avg)}`+(m.showN&&a.n>1?`（${a.n} 站平均）`:"");
    },

    // ---- 地圖繪製 ----
    render(feats){
      const vm=this, ext=[[10,10],[590,690]], c0=this.firstCoord(feats[0].geometry);
      const projected=Math.abs(c0[0])>180||Math.abs(c0[1])>90;
      let path;
      if(projected){
        const idp=d3.geoIdentity(); if(Math.abs(c0[1])>1e5) idp.reflectY(true);
        idp.fitExtent(ext,{type:"FeatureCollection",features:feats});
        path=d3.geoPath(idp);
      }else{
        feats=feats.map(this.rewind);
        path=d3.geoPath(d3.geoMercator().fitExtent(ext,{type:"FeatureCollection",features:feats}));
      }
      const root=d3.select(this.$refs.svg); root.selectAll("*").remove();
      this.g=root.append("g");
      this.g.selectAll("path").data(feats).join("path").attr("class","county").attr("d",path)
        .on("mouseenter",function(e,d){d3.select(this).classed("on",true);vm.info=vm.describe(d);vm.showTip(e,d);})
        .on("mousemove",(e,d)=>this.showTip(e,d))
        .on("mouseleave",function(e,d){d3.select(this).classed("on",vm.nameOf(d)===vm.sel);vm.info="";vm.tip=null;})
        .on("click",(e,d)=>{this.sel=this.nameOf(d);this.showTip(e,d);});
      this.labelG=this.g.append("g");
      this.labelG.selectAll("text").data(feats).join("text").attr("class","lbl")
        .attr("transform",d=>`translate(${path.centroid(d)})`);
      this.iconG=this.g.append("g");
      this.iconG.selectAll("text").data(feats).join("text").attr("class","ico")
        .attr("transform",d=>`translate(${path.centroid(d)})`);
      this.curK=1;
      this.zoomT=d3.zoomIdentity;
      this.centroids=feats.map(d=>({name:this.nameOf(d),c:path.centroid(d)})).filter(n=>n.c.every(isFinite));
      root.call(d3.zoom().scaleExtent([1,14])
        // 框選模式下，滑鼠／觸控拖曳留給框選；滾輪縮放照常
        .filter(e=>(!e.ctrlKey||e.type==="wheel")&&!e.button&&(e.type==="wheel"||!this.brushMode))
        .on("zoom",e=>{this.g.attr("transform",e.transform);this.zoomT=e.transform;this.curK=e.transform.k;this.updateScale();}));
      // 框選層放在縮放群組之外（使用畫面座標），選取時再把各縣市中心點換算成畫面座標比對
      this.brush=d3.brush().extent([[0,0],[600,700]]).on("start brush end",e=>this.onBrush(e));
      this.brushG=root.append("g").attr("class","brush").call(this.brush);
      this.updateBrushMode();
      this.countyNames=feats.map(this.nameOf);
      this.paint();
      this.highlightPicked();
    },
    // ---- 框選（d3.brush）與長條圖 ----
    onBrush(e){
      if(!e.sourceEvent) return;                         // 程式呼叫（清除框選矩形）不處理
      if(!e.selection){ if(this.picked.length) this.picked=[]; this.popupOpen=false; return; }
      const [[x0,y0],[x1,y1]]=e.selection;
      const names=this.centroids.filter(n=>{
        const [sx,sy]=this.zoomT.apply(n.c);
        return sx>=x0&&sx<=x1&&sy>=y0&&sy<=y1;
      }).map(n=>n.name);
      if(names.join("|")!==this.picked.join("|")) this.picked=names;
      if(e.type==="end") this.popupOpen=names.length>0;   // 放開滑鼠才跳出視窗，拖曳過程中不打斷
    },
    updateBrushMode(){
      if(!this.brushG) return;
      this.brushG.style("display",this.brushMode?null:"none");
      this.brushG.call(this.brush.move,null);            // 切換模式時清掉矩形，但保留已選取的縣市
    },
    clearPicked(){
      this.picked=[]; this.popupOpen=false;
      if(this.brushG) this.brushG.call(this.brush.move,null);
    },
    // 拖曳快顯視窗（按住標題列；點到下拉選單或按鈕時不拖曳）
    startDrag(e){
      if(e.target.closest("select,button,label")) return;
      const box=this.$refs.popup.getBoundingClientRect();
      this.drag={dx:e.clientX-box.left,dy:e.clientY-box.top};
      window.addEventListener("pointermove",this.onDrag);
      window.addEventListener("pointerup",this.endDrag);
    },
    onDrag(e){
      if(!this.drag) return;
      const box=this.$refs.popup.getBoundingClientRect();
      this.popupPos={
        x:Math.max(0,Math.min(window.innerWidth-Math.min(box.width,120),e.clientX-this.drag.dx)),
        y:Math.max(0,Math.min(window.innerHeight-48,e.clientY-this.drag.dy))
      };
    },
    endDrag(){
      this.drag=null;
      window.removeEventListener("pointermove",this.onDrag);
      window.removeEventListener("pointerup",this.endDrag);
    },
    highlightPicked(){
      if(this.g) this.g.selectAll(".county").classed("picked",d=>this.picked.includes(this.nameOf(d)));
    },
    drawBars(){
      const el=this.$refs.bars; if(!el) return;
      const svg=d3.select(el); svg.selectAll("*").remove();
      const k=this.chartMetric, m=this.METRICS[k];
      if(!this.picked.length){
        svg.attr("viewBox","0 0 600 60");
        svg.append("text").attr("x",300).attr("y",34).attr("text-anchor","middle").attr("fill","#8e99a8").style("font-size","13px")
          .text("開啟「框選模式」後，在地圖上拖曳選取縣市，這裡會顯示它們的長條圖");
        return;
      }
      const data=this.picked.map(n=>{
        const a=this.allAvg[k].get(this.norm(n)), w=this.wxOf(n);
        return{name:n,v:a?a.avg:null,icon:w?w.icon:""};
      }).sort((a,b)=>(b.v==null?-Infinity:b.v)-(a.v==null?-Infinity:a.v));
      const rowH=26, mt=6, mb=24, ml=96, mr=84, H=mt+mb+data.length*rowH;
      svg.attr("viewBox",`0 0 600 ${H}`);
      const vals=data.map(d=>d.v).filter(v=>v!=null);
      const lo=Math.min(0,d3.min(vals)??0), hi=Math.max(d3.max(vals)??1,lo+1e-6);
      const x=d3.scaleLinear().domain([lo,hi]).nice().range([ml,600-mr]);
      const y=d3.scaleBand().domain(data.map(d=>d.name)).range([mt,mt+data.length*rowH]).padding(.25);
      svg.append("g").attr("transform",`translate(0,${mt+data.length*rowH})`)
        .call(d3.axisBottom(x).ticks(5)).call(g=>g.selectAll("text").style("font-size","16px"));
      svg.append("g").selectAll("rect").data(data).join("rect")
        .attr("x",d=>x(Math.min(0,d.v==null?0:d.v))).attr("y",d=>y(d.name)).attr("height",y.bandwidth()).attr("rx",3)
        .attr("fill",d=>d.v==null?"#d9dee6":this.colorOf(k,d.v)).attr("stroke","rgba(0,0,0,.18)").attr("width",0)
        .transition().duration(350).attr("width",d=>d.v==null?0:Math.abs(x(d.v)-x(0)));
      svg.append("g").selectAll("text").data(data).join("text")
        .attr("x",ml-8).attr("y",d=>y(d.name)+y.bandwidth()/2).attr("dy","0.35em").attr("text-anchor","end")
        .attr("fill","currentColor").style("font-size","18px").text(d=>`${d.icon} ${d.name}`.trim());
      svg.append("g").selectAll("text").data(data).join("text")
        .attr("x",d=>(d.v==null?x(0):x(Math.max(0,d.v)))+5).attr("y",d=>y(d.name)+y.bandwidth()/2).attr("dy","0.35em")
        .attr("fill","currentColor").style("font-size","18px").text(d=>d.v==null?"無資料":m.short(d.v));
    },
    updateScale(){
      if(!this.labelG) return;
      const k=Math.sqrt(this.curK);
      this.labelG.selectAll("text").attr("font-size",9.5/k).attr("stroke-width",2.5/k);
      // 天氣圖示放在名稱上方；沒顯示名稱時置中
      this.iconG.selectAll("text").attr("font-size",15/k).attr("y",(this.showLabels?-11:5)/k);
    },
    paint(){
      if(!this.g) return;
      const m=this.M;
      this.g.selectAll(".county").style("fill",d=>{const a=this.avgMap.get(this.norm(this.nameOf(d)));return a?this.colorOf(this.metric,a.avg):null;});
      this.labelG.style("display",this.showLabels?null:"none");
      this.iconG.style("display",this.showIcons?null:"none");
      this.iconG.selectAll("text").text(d=>{const w=this.wxOf(this.nameOf(d));return w?w.icon:"";});
      this.labelG.selectAll("text").text(d=>{const a=this.avgMap.get(this.norm(this.nameOf(d)));return this.nameOf(d)+(a?` ${m.short(a.avg)}`:"");});
      this.updateScale();
    },
    drawLegend(){
      // 垂直圖例：上＝高值、下＝低值；色條在左、刻度與文字在右
      const m=this.M, l=d3.select(this.$refs.legend); l.selectAll("*").remove();
      const top=22, H=200;
      l.append("text").attr("x",8).attr("y",13).attr("fill","currentColor")
        .style("font-size","12.5px").style("font-weight","600").text(m.label);
      if(m.bands){                                    // 分級色塊（紫外線）：高等級在上
        const h=H/m.bands.length;
        [...m.bands].reverse().forEach((b,i)=>{
          const y=top+i*h, next=m.bands[m.bands.indexOf(b)+1];
          l.append("rect").attr("x",8).attr("y",y).attr("width",16).attr("height",h).attr("fill",b.color);
          l.append("text").attr("x",30).attr("y",y+h/2-2).attr("fill","currentColor").style("font-size","12px").text(b.label);
          l.append("text").attr("x",30).attr("y",y+h/2+12).attr("fill","#6b7685").style("font-size","10.5px")
            .text(next?`${b.from}–${next.from-1}`:`≥${b.from}`);
        });
        return;
      }
      const dom=m.dynamic?[0,this.sunMax]:m.domain, ticks=m.dynamic?d3.ticks(0,this.sunMax,6):m.ticks, [a,b]=dom;
      const gr=l.append("defs").append("linearGradient").attr("id","lg").attr("x1","0%").attr("y1","100%").attr("x2","0%").attr("y2","0%");
      d3.range(0,1.01,.1).forEach(t=>gr.append("stop").attr("offset",t*100+"%").attr("stop-color",this.colorOf(this.metric,a+(b-a)*t)));
      l.append("rect").attr("x",8).attr("y",top).attr("width",16).attr("height",H).attr("rx",8).attr("fill","url(#lg)");
      l.append("g").attr("transform","translate(24,0)")
        .call(d3.axisRight(d3.scaleLinear().domain(dom).range([top+H,top])).tickValues(ticks).tickFormat(m.tickFmt).tickSize(4))
        .call(x=>{x.select(".domain").remove();x.selectAll("text").style("font-size","12px")});
    },

    // ---- 載入縣市邊界 ----
    async loadMap(){
      const errs=[];
      for(const u of this.urls){
        try{
          const feats=this.toFeatures(await d3.json(u));
          this.render(feats); this.status=`已載入 ${feats.length} 個縣市邊界`; return;
        }catch(e){errs.push(`${u} → ${e.message||e}`);}
      }
      this.failed=true; this.status="地圖自動載入失敗：\n"+errs.join("\n");
    },
    onFile(e){
      const f=e.target.files[0]; if(!f) return;
      const r=new FileReader();
      r.onload=()=>{
        try{const feats=this.toFeatures(JSON.parse(r.result));this.render(feats);this.failed=false;this.status=`已載入 ${feats.length} 個圖形（${f.name}）`;}
        catch(err){this.status="檔案讀取失敗："+err.message;this.failed=true;}
      };
      r.readAsText(f);
    },

    netHint(errs){
      if(!errs.some(e=>/NetworkError|Failed to fetch|Load failed/i.test(e))) return "請確認授權碼是否正確。";
      return "瀏覽器擋下了對氣象署的直接呼叫（CORS）。";
    },

    // ---- 中央氣象署即時資料 ----
    async cwa(id){
      const r=await fetch(`https://opendata.cwa.gov.tw/api/v1/rest/datastore/${id}?Authorization=${encodeURIComponent(this.apiKey)}&format=JSON`);
      if(!r.ok) throw new Error(`${id} HTTP ${r.status}`);
      return r.json();
    },
    setData(k,list,src){
      this.datasets={...this.datasets,[k]:list};
      this.sources={...this.sources,[k]:src};
    },
    async loadLive(){
      this.msg="載入中…";
      try{localStorage.setItem("cwa_key",this.apiKey)}catch(e){}
      const errs=[];
      let wxObs=[], wxFc=[], uvRt=[];
      const stationInfo=new Map();   // 測站代碼 → {名稱, 縣市}（紫外線每日最大值資料只有測站代碼，需要靠這張表對應縣市）
      // 1) O-A0003-001（每 10 分鐘更新）：氣溫、紫外線、當日累積雨量、日照時數都在同一份資料裡
      try{
        const j=await this.cwa("O-A0003-001"), st=(j.records&&j.records.Station)||[];
        const pick=(get,ok,fix=v=>v)=>st.map(x=>({name:x.StationName,county:x.GeoInfo&&x.GeoInfo.CountyName,
            v:fix(parseFloat(get(x.WeatherElement||{})))})).filter(r=>r.county&&isFinite(r.v)&&ok(r.v));
        // 天氣現象：觀測的 Weather 欄位（缺值會是 -99 之類的數字，沒有中文就略過）
        wxObs=st.map(x=>({name:x.StationName,county:x.GeoInfo&&x.GeoInfo.CountyName,text:String((x.WeatherElement&&x.WeatherElement.Weather)||"")}))
          .filter(r=>r.county&&/[\u4e00-\u9fff]/.test(r.text));
        st.forEach(x=>stationInfo.set(String(x.StationId),{name:x.StationName,county:x.GeoInfo&&x.GeoInfo.CountyName}));
        const latest=st.map(x=>x.ObsTime&&x.ObsTime.DateTime).filter(Boolean).sort().pop();
        const src="中央氣象署觀測"+(latest?" "+latest.slice(0,16).replace("T"," "):"");
        const defs=[
          ["temp","氣溫",   pick(w=>w.AirTemperature,v=>v>-50&&v<60)],
          ["acc", "累積雨量",pick(w=>w.Now&&w.Now.Precipitation,v=>v>=0&&v<=1500,v=>v===-998?0:v)],  // -998 為微量，以 0 計
          ["sun", "日照時數",pick(w=>w.SunshineDuration,v=>v>=0&&v<=24)]
        ];
        uvRt=pick(w=>w.UVIndex,v=>v>=0&&v<=25);   // 即時讀數：夜間為 0，無感測器的測站為 -99（已略過）
        for(const [k,label,list] of defs){
          if(list.length) this.setData(k,list,src); else errs.push(`${label}：回傳資料中沒有有效數值`);
        }
      }catch(e){errs.push("現在天氣觀測（O-A0003-001）："+(e.message||e));}
      // 1b) 紫外線：優先用「每日最大值」O-A0005-001（即時讀數在夜間會是 0），失敗再退回即時讀數
      let uvDone=false;
      try{
        const j=await this.cwa("O-A0005-001"), rec=j.records||{};
        const we=Array.isArray(rec.weatherElement)?rec.weatherElement[0]:(rec.weatherElement||{});
        const list=(we.location||[]).map(l=>{
          const id=String(l.StationID!==undefined?l.StationID:(l.StationId!==undefined?l.StationId:(l.stationId!==undefined?l.stationId:l.locationCode)));
          const info=stationInfo.get(id);
          return{name:info?info.name:id,county:info&&info.county,v:parseFloat(l.UVIndex!==undefined?l.UVIndex:l.value)};
        }).filter(r=>r.county&&isFinite(r.v)&&r.v>=0&&r.v<=25);
        if(!list.length) throw new Error(`回傳資料中沒有可對應到縣市的有效數值（回傳欄位=${Object.keys(we).join(",")||"無"}；第一筆=${JSON.stringify((we.location||[])[0])||"無"}；測站對照表 ${stationInfo.size} 筆）`);
        this.setData("uv",list,"中央氣象署今日最大值"+(we.Date?" "+String(we.Date).slice(0,10):""));
        uvDone=true;
      }catch(e){errs.push("紫外線今日最大值（O-A0005-001）："+(e.message||e)+"；改用即時讀數");}
      if(!uvDone){
        if(uvRt.length){
          if(uvRt.every(r=>r.v===0)){   // 即時讀數全為 0＝夜間／日出前後，不是真的「紫外線為 0」，略過以免整張圖顯示 0
            errs.push("紫外線：即時讀數全為 0（夜間或日出前後屬正常），且沒有取得今日最大值，已略過");
          }else this.setData("uv",uvRt,"中央氣象署即時讀數");
        }else errs.push("紫外線即時讀數：沒有有效數值");
      }
      // 2) F-C0032-001（36 小時預報）：各縣市降雨機率，取最近一個時段
      try{
        const j=await this.cwa("F-C0032-001");
        const list=j.records.location.map(l=>{
          const pop=l.weatherElement.find(w=>w.elementName==="PoP");
          return{name:l.locationName,county:l.locationName,v:+pop.time[0].parameter.parameterName};
        }).filter(r=>isFinite(r.v));
        if(!list.length) throw new Error("沒有有效數值");
        this.setData("rain",list,"中央氣象署 36 小時預報");
        // 天氣現象預報（Wx）：觀測沒有資料的縣市用它補上
        wxFc=j.records.location.map(l=>{
          const wx=l.weatherElement.find(w=>w.elementName==="Wx");
          return{name:l.locationName,county:l.locationName,text:wx?String(wx.time[0].parameter.parameterName):""};
        }).filter(r=>r.text);
      }catch(e){errs.push("降雨機率（F-C0032-001）："+(e.message||e));}
      const have=new Set(wxObs.map(r=>this.norm(r.county)));
      const wx=[...wxObs,...wxFc.filter(r=>!have.has(this.norm(r.county)))];
      if(wx.length){ this.weather=wx; this.sources={...this.sources,weather:wxObs.length?"中央氣象署觀測（缺資料縣市用預報）":"中央氣象署預報"}; }
      else errs.push("天氣現象：沒有有效資料");
      this.msg=errs.length?"以下項目載入失敗"+(this.hasData?"（維持原有資料）":"")+"：\n"+errs.join("\n")+"\n"+this.netHint(errs):"";
    }
  }
}
</script>

<style scoped>
</style>
