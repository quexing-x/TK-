const root = document.documentElement;
const themeButton = document.querySelector('#themeToggle');
const toast = document.querySelector('#toast');
let toastTimer;
function theme(value){root.dataset.theme=value;const dark=value==='dark';themeButton.setAttribute('aria-pressed',String(dark));themeButton.setAttribute('aria-label',dark?'切换为浅色主题':'切换为深色主题');localStorage.setItem('tk-concept-theme',value)}
theme(localStorage.getItem('tk-concept-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'));
themeButton.addEventListener('click',()=>theme(root.dataset.theme==='dark'?'light':'dark'));
function notify(message){toast.textContent=message;toast.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>toast.classList.remove('show'),2500)}
document.querySelectorAll('[data-toast]').forEach(button=>button.addEventListener('click',()=>notify(button.dataset.toast)));
document.querySelector('[data-recover]').addEventListener('click',(event)=>{const button=event.currentTarget;button.disabled=true;button.textContent='检测中…';setTimeout(()=>{const node=button.closest('.node');const pendingNode=document.querySelector('.node.pending');node.classList.remove('warn');node.classList.add('good');node.querySelector('strong').textContent='创建契约已恢复';node.querySelector('small').textContent='本地凭据检测通过 · 无需重新导入';button.textContent='已恢复';if(pendingNode){pendingNode.classList.replace('pending','good');const pendingButton=pendingNode.querySelector('button');pendingButton.disabled=false;pendingButton.textContent='可执行'}notify('创建能力已恢复，原选择已保留')},700)});
