/* ===================== 全局状态 ===================== */
const S = { role:null, code:null, token:null, name:null, clsName:null, cloud:false, ws:null, lastWord:null };
const LS_T = 'ec_teacher', LS_S = 'ec_student';

function $(s,r=document){return r.querySelector(s);}
function $$(s,r=document){return [...r.querySelectorAll(s)];}
function el(tag, props={}, ...kids){const e=document.createElement(tag);Object.assign(e,props);(kids||[]).forEach(k=>e.append(k));return e;}

async function api(path, opts={}){
  const o={method:opts.method||'GET',headers:{}};
  if(opts.body){o.headers['Content-Type']='application/json';o.body=JSON.stringify(opts.body);}
  if(S.token) o.headers['Authorization']='Bearer '+S.token;
  const res=await fetch('/api'+path,o);
  const data=await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(data.error||('请求失败 '+res.status));
  return data;
}
let toastTimer;
function toast(msg,kind=''){const t=$('#toast');t.textContent=msg;t.className='toast '+(kind||'');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.add('hidden'),2600);}

// 作业到期状态：none / ok / soon / expired
function dueInfo(due){
  if(!due) return {state:'none', text:'无截止'};
  const d=new Date(due+'T23:59:59');
  if(isNaN(d.getTime())) return {state:'none', text:String(due)};
  const diff=d.getTime()-Date.now();
  if(diff<0) return {state:'expired', text:'已过期'};
  const h=diff/3600000;
  if(h<24) return {state:'soon', text:'即将到期·剩'+Math.max(1,Math.ceil(h))+'小时'};
  const days=Math.floor(h/24);
  return {state:'ok', text:'还剩 '+days+' 天'};
}

/* ===================== 语音 / 录音 ===================== */
function speechSupported(){return !!(window.SpeechRecognition||window.webkitSpeechRecognition);}
function speechOnce(onResult,onError){
  const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
  if(!SR){onError&&onError('no-support');return null;}
  const r=new SR();r.lang='en-US';r.interimResults=false;r.maxAlternatives=1;
  r.onresult=e=>onResult(e.results[0][0].transcript);
  r.onerror=e=>onError&&onError(e.error);
  try{r.start();}catch(e){onError&&onError(e.message);}
  return r;
}
function startRecording(){
  return navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{
    const mr=window.MediaRecorder;
    const mime = mr.isTypeSupported('audio/ogg;codecs=opus')?'audio/ogg;codecs=opus':(mr.isTypeSupported('audio/webm;codecs=opus')?'audio/webm;codecs=opus':'');
    const rec=new mr(stream,mime?{mimeType:mime}:undefined);
    const chunks=[];
    rec.ondataavailable=e=>chunks.push(e.data);
    const done=new Promise(res=>{
      rec.onstop=async()=>{
        const blob=new Blob(chunks,{type:mime||'audio/webm'});
        const buf=await blob.arrayBuffer();
        const b64=btoa(String.fromCharCode(...new Uint8Array(buf)));
        stream.getTracks().forEach(t=>t.stop());
        res({audioBase64:b64, voiceFormat: mime.includes('opus')?'opus':'wav'});
      };
    });
    rec.start();
    return { stop:()=>rec.stop(), done };
  });
}

/* ===================== 导航 ===================== */
function show(view){
  $$('.view').forEach(v=>v.classList.add('hidden'));
  $('#'+view).classList.remove('hidden');
}
function goto(id){
  if(id==='home'){show('view-home');return;}
  if(id==='teacher-auth'){show('view-teacher-auth');return;}
  if(id==='student-join'){show('view-student-join');return;}
}
function enterTeacher(cls){
  S.role='teacher';S.code=cls.code;S.token=cls.teacherToken;S.clsName=cls.name;
  if(cls.teacherName)S.teacherName=cls.teacherName;
  localStorage.setItem(LS_T,JSON.stringify(S));
  $('#topbar').classList.remove('hidden');
  $('#topClass').textContent='班级：'+cls.name+'（'+cls.code+'）';
  $('#topRole').textContent='老师'+(S.teacherName?(' · '+S.teacherName):'');
  show('view-teacher');
  setTeacherTab('board');
}
function switchClass(code,name){
  S.code=code;S.clsName=name;
  localStorage.setItem(LS_T,JSON.stringify(S));
  $('#topClass').textContent='班级：'+name+'（'+code+'）';
  setTeacherTab('board');
}
// 教师登录后：一个班级直接进，多个班级弹选择器
function handleTeacherEntry(data){
  S.teacherName=data.teacherName; S.token=data.teacherToken;
  if(data.classes.length===1){
    const c=data.classes[0];
    enterTeacher({code:c.code,teacherToken:data.teacherToken,name:c.name,teacherName:data.teacherName});
  }else{
    showClassPicker(data.teacherToken,data.teacherName,data.classes);
  }
}
function showClassPicker(token,teacherName,classes){
  const mask=el('div',{className:'modal-mask'});
  const m=el('div',{className:'modal'});
  m.append(el('h3',{},'我的班级 · '+(teacherName||'')));
  m.append(el('div',{className:'muted'},'选择要进入的班级，或创建新班级。'));
  const list=el('div',{className:'list'});
  classes.forEach(c=>{
    const enter=el('button',{className:'btn primary sm',textContent:'进入',onclick:()=>{mask.remove();enterTeacher({code:c.code,teacherToken:token,name:c.name,teacherName});}});
    const del=el('button',{className:'btn danger sm',textContent:'删除',onclick:async()=>{
      if(!confirm('确定删除班级「'+c.name+'」？该操作不可恢复。'))return;
      try{await api('/classes/'+c.code,{method:'DELETE'});toast('已删除','ok');showClassPicker(token,teacherName,(await api('/teacher/classes')).classes);}catch(e){toast(e.message,'err');}
    }});
    list.append(el('div',{className:'item'},el('div',{className:'board-rank'},el('div',{},el('div',{className:'title'},c.name),el('div',{className:'meta'},'班级码 '+c.code))),el('div',{className:'row'},enter,del)));
  });
  m.append(list);
  const newBtn=el('button',{className:'btn ghost',textContent:'+ 创建新班级',onclick:()=>{mask.remove();goto('teacher-auth');$('[data-teachertab="create"]').click();}});
  const logoutBtn=el('button',{className:'btn ghost',textContent:'退出登录',onclick:()=>{mask.remove();logout();}});
  m.append(el('div',{className:'row'},newBtn,logoutBtn));
  mask.append(m);document.body.append(mask);
}
function enterStudent(st){
  S.role='student';S.code=st.code;S.token=st.token;S.name=st.name;S.clsName=st.className;
  localStorage.setItem(LS_S,JSON.stringify(S));
  $('#topbar').classList.remove('hidden');
  $('#topClass').textContent='班级：'+st.className+'（'+st.code+'）';
  $('#topRole').textContent='学生 · '+st.name;
  show('view-student');
  setStudentTab('myassign');
}
function logout(){
  if(S.role==='teacher')localStorage.removeItem(LS_T);else localStorage.removeItem(LS_S);
  if(S.ws)try{S.ws.close();}catch(e){} S.ws=null;
  S.role=S.token=S.code=S.name=S.clsName=null;
  $('#topbar').classList.add('hidden');
  show('view-home');
}

/* ===================== 首页 / 鉴权 ===================== */
$$('[data-goto]').forEach(b=>b.addEventListener('click',()=>goto(b.dataset.goto)));
$$('[data-teachertab]').forEach(t=>t.addEventListener('click',()=>{
  $$('[data-teachertab]').forEach(x=>x.classList.remove('active'));
  t.classList.add('active');
  $('#teacher-create').classList.toggle('hidden',t.dataset.teachertab!=='create');
  $('#teacher-login').classList.toggle('hidden',t.dataset.teachertab!=='login');
}));

$('#btnCreateClass').addEventListener('click',async()=>{
  try{
    const cls=await api('/teacher/register',{method:'POST',body:{teacherName:$('#t-tname').value,password:$('#t-pwd').value,className:$('#t-cname').value}});
    toast('班级已创建，班级码：'+cls.code,'ok');
    enterTeacher({code:cls.code,teacherToken:cls.teacherToken,name:cls.className,teacherName:cls.teacherName});
  }catch(e){toast(e.message,'err');}
});
$('#btnTeacherLogin').addEventListener('click',async()=>{
  try{
    const data=await api('/teacher/login',{method:'POST',body:{teacherName:$('#t-lname').value,password:$('#t-lpwd').value}});
    toast('登录成功','ok');
    handleTeacherEntry(data);
  }catch(e){toast(e.message,'err');}
});
$('#btnStudentJoin').addEventListener('click',async()=>{
  try{
    const st=await api('/students/join',{method:'POST',body:{code:$('#s-code').value,name:$('#s-name').value}});
    toast('加入成功','ok');
    enterStudent(st);
  }catch(e){toast(e.message,'err');}
});
$('#btnLogout').addEventListener('click',logout);

/* ===================== 老师：标签切换 ===================== */
$$('#view-teacher .navbtn').forEach(b=>b.addEventListener('click',()=>setTeacherTab(b.dataset.tab)));
function setTeacherTab(tab){
  $$('#view-teacher .navbtn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $$('#view-teacher .tabpane').forEach(p=>p.classList.add('hidden'));
  $('#tab-'+tab).classList.remove('hidden');
  ({board:renderBoard,assignments:renderAssignments,checkin:renderCheckin,rollcall:renderRollcall,words:renderWords,game:renderGame,settings:renderSettings}[tab]||(()=>{}))();
}
/* ===================== 学生：标签切换 ===================== */
$$('#view-student .navbtn').forEach(b=>b.addEventListener('click',()=>setStudentTab(b.dataset.tab)));
function setStudentTab(tab){
  $$('#view-student .navbtn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  $$('#view-student .tabpane').forEach(p=>p.classList.add('hidden'));
  $('#tab-'+tab).classList.remove('hidden');
  ({myassign:renderMyAssign,mycheckin:renderMyCheckin,myboard:renderBoard,mygame:renderMyGame}[tab]||(()=>{}))();
}

/* ===================== 成绩榜（共用） ===================== */
async function renderBoard(){
  const box=document.querySelector('#tab-board,#tab-myboard');
  try{
    const {board,className}=await api(`/classes/${S.code}/board`);
    box.innerHTML='';
    box.append(el('h3',{},'📊 班级成绩榜'));
    box.append(el('div',{className:'muted'},'按最近一次口语评测得分排名；同班同学均可查看。'));
    if(!board.length){box.append(el('div',{className:'empty'},'还没有学生加入'));return;}
    const list=el('div',{className:'list'});
    board.forEach((s,i)=>{
      const rank=el('div',{className:'rank-no'+(i===0?' top':'')},String(i+1));
      const info=el('div',{},
        el('div',{className:'title'},s.name+(s.name===S.name?'（我）':'')),
        el('div',{className:'meta'},s.lastScore?`得分 ${s.lastScore.score} · 准确度${s.lastScore.accuracy}%`:'暂无评测'));
      const pills=el('div',{className:'row'});
      pills.append(
        scorePill(s.checkinDays,'打卡天数'),
        scorePill(Math.round(s.checkinMinutes),'打卡分钟'),
      );
      list.append(el('div',{className:'item'+(s.name===S.name?' me':'')},
        el('div',{className:'board-rank'},rank,info),pills));
    });
    box.append(list);
  }catch(e){box.innerHTML='<div class="empty">加载失败：'+e.message+'</div>';}
}
function scorePill(v,l){return el('div',{className:'score-pill'},el('b',{},String(v)),el('span',{},l));}

/* ===================== 老师：口语作业 ===================== */
let assignWordRows=[]; // {word, meaning}
async function renderAssignments(){
  const box=$('#tab-assignments');box.innerHTML='';
  box.append(el('h3',{},'📝 口语作业'));
  // 新建表单
  const form=el('div',{className:'item'});
  form.append(el('div',{className:'title'},'布置新作业'));
  const titleIn=el('input',{placeholder:'作业标题，如：Unit 3 朗读'});
  const reqMin=el('input',{type:'number',placeholder:'建议时长(分钟)，可留空',value:'2'});
  const due=el('input',{type:'date',placeholder:'截止日期(可选)'});
  const typeSel=el('select',{},el('option',{value:'passage'},'短文朗读'),el('option',{value:'words'},'单词朗读'));
  const passageIn=el('textarea',{placeholder:'朗读内容（短文）',rows:3});
  const wordsBox=el('div',{className:'hidden'});
  const wordsList=el('div',{});
  const addRow=()=>{
    const w=el('input',{placeholder:'单词'}),m=el('input',{placeholder:'释义(可选)'});
    const rm=el('button',{className:'btn danger sm',textContent:'×'});
    const row=el('div',{className:'wrow'},w,m,rm);
    rm.onclick=()=>row.remove();
    wordsList.append(row);
  };
  addRow();
  wordsBox.append(el('div',{className:'muted'},'逐行添加单词：'),wordsList,el('button',{className:'btn ghost sm',textContent:'+ 添加单词',onclick:addRow}));
  typeSel.onchange=()=>{passageIn.parentElement.classList.toggle('hidden',typeSel.value!=='passage');wordsBox.classList.toggle('hidden',typeSel.value!=='words');};
  const submitBtn=el('button',{className:'btn primary',textContent:'发布作业'});
  submitBtn.onclick=async()=>{
    try{
      const body={code:S.code,title:titleIn.value,requiredMinutes:reqMin.value,dueDate:due.value||null,type:typeSel.value};
      if(typeSel.value==='words'){
        const rows=[...wordsList.children].map(r=>({word:r.children[0].value,meaning:r.children[1].value}));
        body.words=rows;
      }else{body.refText=passageIn.value;}
      await api('/assignments',{method:'POST',body});
      toast('作业已发布','ok');renderAssignments();
    }catch(e){toast(e.message,'err');}
  };
  form.append(wrapLabel('标题',titleIn),wrapLabel('类型',typeSel),
    wrapLabel('朗读内容（短文）',passageIn),wordsBox,
    wrapLabel('建议时长(分钟)',reqMin),wrapLabel('截止日期',due),submitBtn);
  box.append(form);

  // 列表
  try{
    const {assignments}=await api(`/classes/${S.code}/assignments`);
    const list=el('div',{className:'list'});
    if(!assignments.length)list.append(el('div',{className:'empty'},'还没有作业'));
    assignments.forEach(a=>{
      const item=el('div',{className:'item'});
      const di=dueInfo(a.due_date);
      item.append(el('div',{className:'title'},a.title),
        el('div',{className:'meta'},[
          el('span',{className:'tag'+(a.type==='words'?' words':'')},a.type==='words'?'单词朗读':'短文朗读'),
          el('span',{className:'due due-'+di.state},di.text)
        ]));
      const viewBtn=el('button',{className:'btn sm',textContent:'查看提交'});
      viewBtn.onclick=()=>viewSubmissions(a);
      const expBtn=el('button',{className:'btn sm',textContent:'导出Excel'});
      expBtn.onclick=()=>window.open(`/api/assignments/${a.id}/export?token=${S.token}`);
      item.append(el('div',{className:'row'},viewBtn,expBtn));
      if(a.type==='words'){
        const wj=JSON.parse(a.words_json||'[]');
        item.append(el('div',{className:'muted'},'单词：'+wj.map(w=>w.word).join('、')));
      }else{
        item.append(el('div',{className:'muted'},'内容：'+a.ref_text));
      }
      list.append(item);
    });
    box.append(list);
  }catch(e){box.append(el('div',{className:'empty'},'加载失败：'+e.message));}
}
function wrapLabel(t,node){return el('label',{},t,node);}
async function viewSubmissions(a){
  try{
    const {title,submissions}=await api(`/assignments/${a.id}/submissions`);
    const mask=el('div',{className:'modal-mask'});
    const m=el('div',{className:'modal'});
    m.append(el('h3',{},'提交情况 · '+title));
    if(!submissions.length)m.append(el('div',{className:'empty'},'还没有学生提交'));
    else{
      const tb=el('table');
      tb.innerHTML='<tr><th>姓名</th><th>总分</th><th>准确度</th><th>完整度</th><th>朗读内容</th><th>方式</th></tr>';
      submissions.forEach(s=>{tb.append(el('tr',{},el('td',{},s.name),el('td',{},String(s.score)),el('td',{},s.accuracy+'%'),el('td',{},s.completeness+'%'),el('td',{},s.transcript||''),el('td',{},s.source)));});
      m.append(tb);
    }
    const close=el('button',{className:'btn primary',textContent:'关闭'});
    close.onclick=()=>mask.remove();
    m.append(el('div',{className:'row'},close));
    mask.append(m);document.body.append(mask);
  }catch(e){toast(e.message,'err');}
}

/* ===================== 老师：每日打卡 ===================== */
async function renderCheckin(){
  const box=$('#tab-checkin');box.innerHTML='';
  box.append(el('h3',{},'✅ 每日打卡记录'));
  const exp=el('button',{className:'btn primary',textContent:'一键导出班级打卡 Excel'});
  exp.onclick=()=>window.open(`/api/classes/${S.code}/export?token=${S.token}`);
  box.append(el('div',{className:'row'},exp));
  try{
    const {checkins}=await api(`/classes/${S.code}/checkins`);
    if(!checkins.length){box.append(el('div',{className:'empty'},'还没有打卡记录'));return;}
    const tb=el('table');
    tb.innerHTML='<tr><th>姓名</th><th>日期</th><th>开始</th><th>结束</th><th>时长(分)</th><th>状态</th></tr>';
    checkins.forEach(c=>tb.append(el('tr',{},el('td',{},c.name),el('td',{},c.date),el('td',{},c.start),el('td',{},c.end),el('td',{},String(c.min)),el('td',{},c.status))));
    box.append(tb);
  }catch(e){box.append(el('div',{className:'empty'},'加载失败：'+e.message));}
}

/* ===================== 老师：上课点名 ===================== */
async function renderRollcall(){
  const box=$('#tab-rollcall');box.innerHTML='';
  box.append(el('h3',{},'🙋 上课点名'));
  const methodSel=el('select',{},el('option',{value:'random'},'随机点名'),el('option',{value:'sequence'},'顺序点名'),el('option',{value:'group'},'按小组点名'));
  const groupsBox=el('div',{className:'hidden'});
  const groupsList=el('div',{});
  const addGroup=()=>{
    const gn=el('input',{placeholder:'组名，如：第一组'});
    const gm=el('input',{placeholder:'组员姓名，逗号分隔'});
    const rm=el('button',{className:'btn danger sm',textContent:'×'});
    const row=el('div',{className:'wrow'},gn,gm,rm);rm.onclick=()=>row.remove();
    groupsList.append(row);
  };
  groupsBox.append(el('div',{className:'muted'},'配置小组（点名时只在所选组内抽取）：'),groupsList,el('button',{className:'btn ghost sm',textContent:'+ 添加小组',onclick:addGroup}));
  methodSel.onchange=()=>groupsBox.classList.toggle('hidden',methodSel.value!=='group');
  const save=el('button',{className:'btn primary',textContent:'保存点名设置'});
  save.onclick=async()=>{
    try{
      const groups={};
      if(methodSel.value==='group')[...groupsList.children].forEach(r=>{const n=r.children[0].value.trim();const ms=r.children[1].value.split(/[,，]/).map(x=>x.trim()).filter(Boolean);if(n)groups[n]=ms;});
      await api(`/classes/${S.code}/rollcall`,{method:'PUT',body:{code:S.code,method:methodSel.value,groups}});
      toast('已保存','ok');
    }catch(e){toast(e.message,'err');}
  };
  // 抽取
  const pickGroupSel=el('select',{},el('option',{value:''},'全班'));
  const pickBtn=el('button',{className:'btn primary',textContent:'开始点名'});
  const resultBox=el('div',{className:'buzz-word'});
  pickBtn.onclick=async()=>{
    try{
      const g=pickGroupSel.value||undefined;
      const r=await api(`/classes/${S.code}/rollcall/pick`,{method:'POST',body:{code:S.code,group:g}});
      resultBox.textContent='🎯 '+r.name;
    }catch(e){toast(e.message,'err');}
  };
  box.append(wrapLabel('点名方式',methodSel),groupsBox,save,el('hr',{}),
    el('div',{className:'muted'},'抽取：'),wrapLabel('小组(可选)',pickGroupSel),pickBtn,resultBox);
  // 载入已有设置
  try{
    const {method,groups}=await api(`/classes/${S.code}/rollcall`);
    methodSel.value=method||'random';groupsBox.classList.toggle('hidden',method!=='group');
    Object.entries(groups||{}).forEach(([n,ms])=>{const row=el('div',{className:'wrow'},el('input',{value:n}),el('input',{value:ms.join('，')}),el('button',{className:'btn danger sm',textContent:'×',onclick:()=>row.remove()}));groupsList.append(row);});
    Object.keys(groups||{}).forEach(n=>pickGroupSel.append(el('option',{value:n},n)));
  }catch(e){}
}

/* ===================== 老师：单词库 ===================== */
async function renderWords(){
  const box=$('#tab-words');box.innerHTML='';
  box.append(el('h3',{},'🔤 单词库（供抢答 / 消消乐 / 单词朗读作业使用）'));
  const w=el('input',{placeholder:'英文单词'}),m=el('input',{placeholder:'中文释义(可选)'});
  const add=el('button',{className:'btn primary',textContent:'添加单词'});
  add.onclick=async()=>{
    try{await api('/words',{method:'POST',body:{code:S.code,word:w.value,meaning:m.value}});w.value='';m.value='';renderWords();toast('已添加','ok');}
    catch(e){toast(e.message,'err');}
  };
  box.append(el('div',{className:'row'},w,m,add));
  try{
    const {words}=await api(`/classes/${S.code}/words`);
    const list=el('div',{className:'list'});
    if(!words.length)list.append(el('div',{className:'empty'},'单词库为空，先添加一些单词吧'));
    words.forEach(x=>{
      const d=el('button',{className:'btn danger sm',textContent:'删除'});
      d.onclick=async()=>{try{await api('/words/'+x.id,{method:'DELETE'});renderWords();}catch(e){toast(e.message,'err');}};
      list.append(el('div',{className:'item'},el('div',{className:'board-rank'},el('div',{},el('div',{className:'title'},x.word),el('div',{className:'meta'},x.meaning||''))),el('div',{className:'row'},d)));
    });
    box.append(list);
  }catch(e){box.append(el('div',{className:'empty'},'加载失败：'+e.message));}
}

/* ===================== 老师：单词游戏（抢答控制台 / 消消乐） ===================== */
async function renderGame(){
  const box=$('#tab-game');box.innerHTML='';
  box.append(el('h3',{},'🎮 单词游戏'));
  box.append(el('div',{className:'mode-cards'},
    el('div',{className:'mode-card',onclick:()=>openBuzzConsole()},el('h3',{},'⚡ 抢答模式'),el('p',{},'课堂个人或小组 PK。学生用手机实时抢答，老师在大屏记分。')),
    el('div',{className:'mode-card',onclick:()=>openMatch('teacher')},el('h3',{},'🧩 消消乐模式'),el('p',{},'学生课堂练习用：翻牌配对单词与释义，巩固记忆。'))
  ));
}
let buzzWs=null;
async function openBuzzConsole(){
  const box=$('#tab-game');box.innerHTML='';
  box.append(el('h3',{},'⚡ 抢答模式（控制台）'));
  const status=el('div',{className:'muted'},'正在连接…');
  const wordDisp=el('div',{className:'buzz-word'},'等待开始');
  const drawBtn=el('button',{className:'btn primary',textContent:'🎲 抽取单词'});
  const manualIn=el('input',{placeholder:'或手动输入单词/句子'});
  const startBtn=el('button',{className:'btn primary',textContent:'开始抢答'});
  const resetBtn=el('button',{className:'btn ghost',textContent:'结束本轮'});
  const targetSel=el('select',{},el('option',{value:'individual'},'记分到个人'),el('option',{value:'group'},'记分到小组'));
  const orderBox=el('div',{className:'buzz-order'});
  const scoreBox=el('div',{className:'scoreboard'});
  const back=el('button',{className:'btn ghost',textContent:'← 返回',onclick:renderGame});

  drawBtn.onclick=async()=>{
    try{const r=await api(`/classes/${S.code}/game/round`,{method:'POST',body:{}});manualIn.value=r.word+(r.meaning?' ('+r.meaning+')':'');toast('已抽取：'+r.word,'ok');}catch(e){toast(e.message,'err');}
  };
  startBtn.onclick=()=>{const w=manualIn.value.trim();if(!w){toast('请先抽取或输入单词','err');return;}buzzSend({type:'buzz:start',word:w});};
  resetBtn.onclick=()=>buzzSend({type:'buzz:reset'});
  targetSel.onchange=()=>buzzSend({type:'buzz:setTarget',target:targetSel.value});

  box.append(status,el('div',{className:'row'},drawBtn,manualIn,startBtn,resetBtn),
    el('div',{className:'row'},wrapLabel('计分方式',targetSel)),wordDisp,el('h3',{},'抢答顺序'),orderBox,el('h3',{},'记分榜'),scoreBox,back);

  connectBuzz('teacher',room=>{
    status.textContent= room.status==='waiting'?'🔴 抢答进行中…':(room.status==='idle'?'就绪':'—');
    wordDisp.innerHTML = room.word? room.word.word+'<span class="mean">'+(room.word.meaning||'')+'</span>':'等待开始';
    targetSel.value=room.target;
    orderBox.innerHTML='';
    if(!room.buzzOrder.length)orderBox.append(el('div',{className:'muted'},'暂无学生抢答'));
    room.buzzOrder.forEach((b,i)=>{
      const award=el('div',{className:'row'});
      const ok=el('button',{className:'btn sm',textContent:'✓ 对',onclick:()=>buzzSend({type:'buzz:award',name:b.name,correct:true})});
      const no=el('button',{className:'btn sm danger',textContent:'✗ 错',onclick:()=>buzzSend({type:'buzz:award',name:b.name,correct:false})});
      award.append(ok,no);
      orderBox.append(el('div',{className:'o'},el('span',{className:'pos'},'#'+(i+1)),el('span',{},b.name),el('span',{},award)));
    });
    renderScoreboard(scoreBox,room);
  });
}
function renderScoreboard(box,room){
  box.innerHTML='';
  if(room.target==='group' && room.groups && Object.keys(room.groups).length){
    const sum={};
    Object.entries(room.groups).forEach(([g,ns])=>{sum[g]=ns.reduce((a,n)=>a+(room.scores[n]||0),0);});
    Object.entries(sum).sort((a,b)=>b[1]-a[1]).forEach(([g,p])=>box.append(el('div',{className:'sb'},el('span',{},'👥 '+g),el('b',{},String(p)))));
  }else{
    Object.entries(room.scores).sort((a,b)=>b[1]-a[1]).forEach(([n,p])=>box.append(el('div',{className:'sb'},el('span',{},n),el('b',{},String(p)))));
  }
}
function buzzSend(obj){if(buzzWs&&buzzWs.readyState===1)buzzWs.send(JSON.stringify(obj));}
function connectBuzz(role,onState){
  if(buzzWs)try{buzzWs.close();}catch(e){}
  const proto=location.protocol==='https:'?'wss':'ws';
  buzzWs=new WebSocket(`${proto}://${location.host}`);
  buzzWs.onmessage=e=>{
    const m=JSON.parse(e.data);
    if(m.type==='state')onState(m.room);
    else if(m.type==='error')toast(m.error,'err');
  };
  buzzWs.onopen=()=>buzzWs.send(JSON.stringify({type:'join',code:S.code,token:S.token}));
}

/* ===================== 消消乐（翻牌配对） ===================== */
let matchState=null;
async function openMatch(who){
  const box = who==='teacher'? $('#tab-game') : $('#tab-mygame');
  box.innerHTML='';
  box.append(el('h3',{},'🧩 消消乐 · 单词配对练习'));
  box.append(el('div',{className:'muted'},'翻开两张卡，把英文单词和对应释义配成一对。'));
  const grid=el('div',{className:'match-grid'});
  const info=el('div',{className:'muted'});
  const restart=el('button',{className:'btn ghost',textContent:'重玩',onclick:()=>openMatch(who)});
  const back=el('button',{className:'btn ghost',textContent:'← 返回',onclick:who==='teacher'?renderGame:()=>setStudentTab('mygame')});
  box.append(info,grid,el('div',{className:'row'},restart,who==='teacher'?back:back));
  try{
    const {words}=await api(`/classes/${S.code}/words`);
    if(words.length<2){box.append(el('div',{className:'empty'},'单词库至少需要 2 个单词'));return;}
    const picks=words.slice(0,8);
    let cards=[];
    picks.forEach(w=>{cards.push({text:w.word,sub:'',en:true,key:w.word});cards.push({text:w.meaning||w.word,sub:'',en:false,key:w.word});});
    cards=cards.sort(()=>Math.random()-0.5);
    let flipped=[],matched=0,moves=0;
    matchState={total:cards.length/2};
    grid.innerHTML='';
    cards.forEach((c,i)=>{
      const card=el('div',{className:'mcard'},el('div',{className:c.en?'en':'cn'},c.text));
      card.onclick=()=>{
        if(card.classList.contains('flipped')||card.classList.contains('matched')||flipped.length===2)return;
        card.classList.add('flipped');flipped.push({card,c});
        if(flipped.length===2){
          moves++;info.textContent='已翻 '+moves+' 次';
          const [a,b]=flipped;
          if(a.c.key===b.c.key){a.card.classList.add('matched');b.card.classList.add('matched');flipped=[];matched++;
            if(matched===matchState.total){info.textContent='🎉 全部配对完成！共 '+moves+' 次';}}
          else{setTimeout(()=>{a.card.classList.remove('flipped');b.card.classList.remove('flipped');flipped=[];},800);}
        }
      };
      grid.append(card);
    });
  }catch(e){box.append(el('div',{className:'empty'},'加载失败：'+e.message));}
}

/* ===================== 老师：设置（多班级管理 / 删除班级） ===================== */
async function renderSettings(){
  const box=$('#tab-settings');box.innerHTML='';
  box.append(el('h3',{},'⚙️ 班级设置'));
  // 我的班级（切换 / 删除 / 新建）
  box.append(el('h3',{},'🏫 我的班级'));
  const myList=el('div',{className:'list'});
  box.append(myList);
  try{
    const {classes}=await api('/teacher/classes');
    if(!classes.length)myList.append(el('div',{className:'empty'},'暂无班级'));
    classes.forEach(c=>{
      const isCur=c.code===S.code;
      const sw=el('button',{className:'btn '+(isCur?'ghost':'primary')+' sm',textContent:isCur?'当前班级':'进入',disabled:isCur,onclick:()=>{if(!isCur){switchClass(c.code,c.name);toast('已切换到 '+c.name,'ok');}}});
      const del=el('button',{className:'btn danger sm',textContent:'删除',onclick:()=>confirmDeleteClass(c.code,c.name)});
      myList.append(el('div',{className:'item'+(isCur?' me':'')},el('div',{className:'board-rank'},el('div',{},el('div',{className:'title'},c.name+(isCur?'（当前）':'')),el('div',{className:'meta'},'班级码 '+c.code))),el('div',{className:'row'},sw,del)));
    });
  }catch(e){}
  const newBtn=el('button',{className:'btn primary',textContent:'+ 创建新班级',onclick:()=>goto('teacher-auth')});
  box.append(el('div',{className:'row'},newBtn));
  box.append(el('hr',{}));
  // 删除当前班级
  box.append(el('div',{className:'item'},
    el('div',{className:'title'},'删除当前班级（'+S.clsName+'）'),
    el('div',{className:'meta'},'删除后，本班所有学生、作业、打卡、单词、成绩将一并清除，且不可恢复。'),
    el('button',{className:'btn danger',textContent:'删除此班级',onclick:()=>confirmDeleteClass(S.code,S.clsName)})));
}
function confirmDelete(){ confirmDeleteClass(S.code,S.clsName); }
function confirmDeleteClass(code,name){
  const mask=el('div',{className:'modal-mask'});
  const m=el('div',{className:'modal'});
  m.append(el('h3',{},'确认删除班级「'+name+'」？'));
  m.append(el('div',{},'此操作不可恢复。请输入班级码 '+code+' 以确认：'));
  const inp=el('input',{placeholder:'输入班级码'});
  const ok=el('button',{className:'btn danger',textContent:'确认删除'});
  ok.onclick=async()=>{
    if(inp.value.trim().toUpperCase()!==code){toast('班级码不正确','err');return;}
    try{await api('/classes/'+code,{method:'DELETE'});localStorage.removeItem(LS_T);toast('班级已删除','ok');logout();}catch(e){toast(e.message,'err');}
  };
  const cancel=el('button',{className:'btn ghost',textContent:'取消',onclick:()=>mask.remove()});
  m.append(el('div',{className:'row'},cancel,ok));mask.append(m);document.body.append(mask);
}

/* ===================== 学生：我的作业 ===================== */
async function renderMyAssign(){
  const box=$('#tab-myassign');box.innerHTML='';
  box.append(el('h3',{},'📚 我的作业'));
  try{
    const {assignments}=await api(`/classes/${S.code}/assignments`);
    const list=el('div',{className:'list'});
    if(!assignments.length)list.append(el('div',{className:'empty'},'老师还没有布置作业'));
    // 到期提醒横幅：未提交且临近/已过期的作业
    const reminders=assignments.filter(a=>!a.submitted && (()=>{const s=dueInfo(a.due_date).state;return s==='soon'||s==='expired';})());
    if(reminders.length)box.append(el('div',{className:'reminder'},'⏰ 你有 '+reminders.length+' 项作业临近截止或已过期，请尽快完成！'));
    assignments.forEach(a=>{
      const di=dueInfo(a.due_date);
      const item=el('div',{className:'item'+(a.submitted?' done':'')});
      item.append(el('div',{className:'title'},a.title),
        el('div',{className:'meta'},[
          el('span',{className:'tag'+(a.type==='words'?' words':'')},a.type==='words'?'单词朗读':'短文朗读'),
          el('span',{className:'due due-'+di.state},di.text),
          a.submitted?el('span',{className:'due due-ok'},'✓ 已提交 '+(a.myScore!=null?('得分'+a.myScore):'')):''
        ].filter(Boolean)));
      const doBtn=el('button',{className:'btn primary sm',textContent:a.submitted?'重做':'去做'});
      doBtn.onclick=()=>doAssignment(a);
      item.append(el('div',{className:'row'},doBtn));
      list.append(item);
    });
    box.append(list);
  }catch(e){box.append(el('div',{className:'empty'},'加载失败：'+e.message));}
}
async function doAssignment(a){
  const mask=el('div',{className:'modal-mask'});
  const m=el('div',{className:'modal'});
  m.append(el('h3',{},a.title));
  const result=el('div',{className:'buzz-word'});
  const hint=el('div',{className:'muted'});
  let durationSec=0; const t0=Date.now();
  if(a.type==='words'){
    const wj=JSON.parse(a.words_json||'[]');
    hint.textContent='逐词朗读，点击下方麦克风朗读每个单词。';
    const wrap=el('div',{});
    const transcripts={};
    wj.forEach((w,i)=>{
      const line=el('div',{className:'wrow'},
        el('div',{},el('b',{},(i+1)+'. '+w.word+(w.meaning?' ('+w.meaning+')':''))),
        el('input',{placeholder:'朗读内容',readOnly:true}),
        el('button',{className:'btn sm',textContent:'🎤'}));
      const mic=line.children[2], inp=line.children[1];
      mic.onclick=()=>{
        if(!speechSupported()){inp.readOnly=false;inp.focus();toast('当前浏览器不支持语音，请手动输入','err');return;}
        toast('请朗读：'+w.word);
        speechOnce(t=>{inp.value=t;transcripts[w.word]=t;toast('已识别','ok');},err=>{inp.readOnly=false;inp.focus();toast('识别失败，请手动输入','err');});
      };
      wrap.append(line);
    });
    m.append(hint,wrap);
    const sub=el('button',{className:'btn primary',textContent:'提交作业'});
    sub.onclick=async()=>{
      try{
        const r=await api(`/assignments/${a.id}/submit`,{method:'POST',body:{wordResults:transcripts,durationSec:Math.round((Date.now()-t0)/1000)}});
        result.innerHTML='得分 <b>'+r.result.score+'</b> · 准确度'+r.result.accuracy+'%';
        mask.querySelector('.modal').append(result);toast('提交成功','ok');
      }catch(e){toast(e.message,'err');}
    };
    m.append(sub);
  }else{
    hint.textContent='朗读下面的短文，点击下方麦克风开始（或录音）。';
    const ref=el('div',{className:'item'},a.ref_text);
    const rec=el('textarea',{placeholder:'朗读内容将自动填入',rows:3,readOnly:true});
    const micBtn=el('button',{className:'btn primary',textContent:'🎤 开始朗读'});
    micBtn.onclick=()=>{
      if(!speechSupported()){rec.readOnly=false;rec.focus();toast('当前浏览器不支持语音，请手动输入','err');return;}
      toast('请朗读短文');
      speechOnce(t=>{rec.value=t;toast('已识别','ok');},()=>{rec.readOnly=false;rec.focus();toast('识别失败，请手动输入','err');});
    };
    m.append(hint,ref,micBtn,rec);
    const sub=el('button',{className:'btn primary',textContent:'提交作业'});
    sub.onclick=async()=>{
      try{
        const body={transcript:rec.value,durationSec:Math.round((Date.now()-t0)/1000)};
        if(S.cloud && rec.value.trim()){
          try{
            toast('录音中…请朗读');
            const r=await startRecording();
            setTimeout(()=>r.stop(),4000);
            const audio=await r.done;
            body.audioBase64=audio.audioBase64; body.voiceFormat=audio.voiceFormat;
          }catch(e){/* 录音失败则用识别文本本地评分 */}
        }
        const r=await api(`/assignments/${a.id}/submit`,{method:'POST',body});
        result.innerHTML='得分 <b>'+r.result.score+'</b> · 准确度'+r.result.accuracy+'% · 流利度'+r.result.fluency+'% · 完整度'+r.result.completeness+'%';
        mask.querySelector('.modal').append(result);toast('提交成功','ok');
      }catch(e){toast(e.message,'err');}
    };
    m.append(sub);
  }
  const close=el('button',{className:'btn ghost',textContent:'关闭',onclick:()=>mask.remove()});
  m.append(el('div',{className:'row'},close));
  mask.append(m);document.body.append(mask);
}

/* ===================== 学生：每日打卡 ===================== */
let checkinId=null,checkinTimer=null;
async function renderMyCheckin(){
  const box=$('#tab-mycheckin');box.innerHTML='';
  box.append(el('h3',{},'⏱️ 每日口语打卡'));
  box.append(el('div',{className:'muted'},'最低打卡 10 分钟，不足不计入。建议朗读课文或单词。'));
  const timer=el('div',{className:'timer'},'00:00');
  const startBtn=el('button',{className:'btn primary',textContent:'开始打卡'});
  const endBtn=el('button',{className:'btn danger',textContent:'结束打卡',disabled:true});
  const status=el('div',{className:'muted'});
  startBtn.onclick=async()=>{
    try{
      const r=await api('/checkins/start',{method:'POST',body:{code:S.code}});
      checkinId=r.checkinId;startBtn.disabled=true;endBtn.disabled=false;
      let s=0;checkinTimer=setInterval(()=>{s++;const mm=String(Math.floor(s/60)).padStart(2,'0'),ss=String(s%60).padStart(2,'0');timer.textContent=mm+':'+ss;timer.classList.toggle('warn',s<600);},1000);
      toast('打卡开始','ok');
    }catch(e){toast(e.message,'err');}
  };
  endBtn.onclick=async()=>{
    try{
      const r=await api('/checkins/end',{method:'POST',body:{code:S.code,checkinId}});
      clearInterval(checkinTimer);startBtn.disabled=false;endBtn.disabled=true;timer.textContent='00:00';timer.classList.remove('warn');
      toast('打卡完成，时长 '+Math.round(r.durationSec/60)+' 分钟','ok');
    }catch(e){toast(e.message+'（本次不计入）','err');}
  };
  box.append(timer,el('div',{className:'row'},startBtn,endBtn),status);
  // 我的打卡记录
  try{
    const {checkins}=await api(`/classes/${S.code}/checkins`);
    const mine=checkins.filter(c=>c.name===S.name);
    box.append(el('h3',{},'我的打卡记录（'+mine.length+' 次）'));
    if(!mine.length)box.append(el('div',{className:'empty'},'还没有打卡记录'));
    else{const tb=el('table');tb.innerHTML='<tr><th>日期</th><th>时长(分)</th><th>状态</th></tr>';
      mine.forEach(c=>tb.append(el('tr',{},el('td',{},c.date),el('td',{},String(c.min)),el('td',{},c.status))));box.append(tb);}
  }catch(e){}
}

/* ===================== 学生：单词游戏 ===================== */
async function renderMyGame(){
  const box=$('#tab-mygame');box.innerHTML='';
  box.append(el('h3',{},'🎮 单词游戏'));
  box.append(el('div',{className:'mode-cards'},
    el('div',{className:'mode-card',onclick:()=>openBuzzBuzzer()},el('h3',{},'⚡ 抢答'),el('p',{},'老师发起抢答后，点这里的大按钮抢答！')),
    el('div',{className:'mode-card',onclick:()=>openMatch('student')},el('h3',{},'🧩 消消乐'),el('p',{},'自己练习：翻牌配对单词和释义。'))
  ));
}
function openBuzzBuzzer(){
  const box=$('#tab-mygame');box.innerHTML='';
  box.append(el('h3',{},'⚡ 抢答'));
  const status=el('div',{className:'muted'},'等待老师开始…');
  const wordDisp=el('div',{className:'buzz-word'},'等待开始');
  const buzzBtn=el('button',{className:'buzz-btn',textContent:'🟢 抢答！',disabled:true});
  const orderBox=el('div',{className:'buzz-order'});
  const back=el('button',{className:'btn ghost',textContent:'← 返回',onclick:()=>setStudentTab('mygame')});
  buzzBtn.onclick=()=>{buzzSend({type:'buzz'});buzzBtn.disabled=true;buzzBtn.textContent='已抢答，等待老师…';};
  box.append(status,wordDisp,buzzBtn,el('h3',{},'抢答顺序'),orderBox,back);
  connectBuzz('student',room=>{
    status.textContent= room.status==='waiting'?'🔴 快抢答！':(room.status==='idle'?'等待老师开始…':'—');
    wordDisp.innerHTML = room.word? room.word.word+'<span class="mean">'+(room.word.meaning||'')+'</span>':'等待开始';
    buzzBtn.disabled = !(room.status==='waiting');
    if(room.status==='waiting')buzzBtn.textContent='🟢 抢答！';
    orderBox.innerHTML='';
    if(!room.buzzOrder.length)orderBox.append(el('div',{className:'muted'},'暂无抢答'));
    room.buzzOrder.forEach((b,i)=>orderBox.append(el('div',{className:'o'},el('span',{className:'pos'},'#'+(i+1)),el('span',{},b.name+(b.name===S.name?'（我）':'')))));
  });
}

/* ===================== 启动 ===================== */
(async function init(){
  try{const c=await api('/assess/config');S.cloud=!!c.cloud;}catch(e){}
  const t=localStorage.getItem(LS_T),s=localStorage.getItem(LS_S);
  if(t){try{const o=JSON.parse(t);enterTeacher(o);return;}catch(e){}}
  if(s){try{const o=JSON.parse(s);enterStudent(o);return;}catch(e){}}
  show('view-home');
})();
