'use strict';
// Developer helper: captures screenshots of the main screens (run with --demo --screenshots=<dir>).
const fs = require('fs');
const path = require('path');

module.exports = async function shots(win, dir, done) {
  fs.mkdirSync(dir, { recursive: true });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const run = (js) => win.webContents.executeJavaScript(js, true);
  const snap = async (name) => {
    await wait(450);
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(dir, `${name}.png`), img.toPNG());
  };
  win.setSize(1040, 740);
  win.show();
  await wait(1500);
  const errors = [];
  win.webContents.on('console-message', (_e, level, msg) => { if (level >= 2) errors.push(msg); });
  try {
    await run(`sa.getState().then((s) => { S.st = s; })`);
    await wait(300);
    await run(`go('receive')`); await snap('receive');
    await run(`S.showInfo = true; go('receive')`); await snap('receive-info');
    await run(`S.showInfo = false; addItems([{id:'a',kind:'file',path:'C:/x/Quarterly report.pdf',name:'Quarterly report.pdf',size:4100000},{id:'b',kind:'folder',path:'C:/x/Project',name:'Project',count:128,size:52000000},{id:'c',kind:'text',text:'https://example.com/meeting-notes — see section 4 for the VPN rollout plan'}]); go('send')`);
    await snap('send');
    await run(`go('send'); S.selection=[]; go('send')`); await snap('send-empty');
    await run(`go('networks')`); await snap('networks');
    await run(`window.scrollTo(0,0); document.getElementById('content').scrollTop = 900`); await snap('networks-2');
    await run(`go('settings')`); await snap('settings');
    await run(`go('history')`); await snap('history');
    await run(`go('send'); rangeDialog()`); await run(`document.querySelector('.dialog input[placeholder*="10.20"]').value='10.20.4.0/24'; document.querySelector('.dialog input[placeholder*="10.20"]').dispatchEvent(new Event('input'))`); await snap('range-dialog');
    await run(`closeDialog('range'); go('send'); troubleshootDialog()`); await snap('troubleshoot');
    await run(`closeDialog('trouble'); onEvent({type:'receive-request',data:{id:'r1',sender:{alias:'Priya\\u2019s Laptop',ip:'10.20.4.88',deviceModel:'macOS',deviceType:'desktop',net:{kind:'vpn',label:'Branch VPN'}},count:14,totalSize:93000000,isMessage:false,files:[{name:'Design review.pptx',size:41000000},{name:'assets/logo.svg',size:12000},{name:'assets/hero.png',size:2100000}],destination:'C:/Users/me/Downloads/LocalSendPlus'}})`);
    await snap('request');
    await run(`closeDialog('request:r1', true); onEvent({type:'transfer',data:{id:'t1',direction:'send',peer:{alias:'London Build Server',ip:'10.20.4.15',deviceType:'server',net:{kind:'vpn',label:'Branch VPN'}},status:'transferring',startedAt:Date.now()-8000,speed:12400000,fileCount:3,total:90000000,done:41000000,files:[{id:'1',name:'Quarterly report.pdf',size:4100000,done:4100000,status:'done'},{id:'2',name:'Project/src/main.c',size:45000000,done:36900000,status:'sending'},{id:'3',name:'Project/data.bin',size:40900000,done:0,status:'waiting'}]}})`);
    await run(`openTransferDialog('t1')`); await snap('transfer');
    await run(`closeDialog('transfer:t1', true); S.dialogs.forEach((d,k)=>closeDialog(k,true)); onEvent({type:'message-received',data:{text:'Deploy key is in the shared vault — ping me if you cannot reach 10.20.4.15 over the tunnel.',peer:{alias:'Secret Banana'},copied:true}})`);
    await snap('message');
    await run(`document.documentElement.classList.remove('dark'); S.st.settings.theme='light'; applyTheme(); S.dialogs.forEach((d,k)=>closeDialog(k,true)); S.selection=[]; go('send')`); await snap('send-light');
    await run(`S.st.settings.theme='dark'; applyTheme(); S.selection=[{id:'a',kind:'file',path:'C:/x/report.pdf',name:'report.pdf',size:4100000}]; go('send')`); await snap('send-dark');
    await run(`go('networks')`); await snap('networks-dark');
    const real = path.join(dir, 'Quarterly report.pdf');
    fs.writeFileSync(real, Buffer.alloc(4100000, 1));
    await run(`S.st.settings.theme='light'; applyTheme(); S.selection=[{id:'a',kind:'file',path:${JSON.stringify(real)},name:'Quarterly report.pdf',size:4100000}]; go('send'); shareDialog()`); await snap('share-setup');
    await run(`[...document.querySelectorAll('.dialog .btn')].find(b => /Start sharing/.test(b.textContent)).click()`); await wait(900); await snap('share-running');
    await run(`closeDialog('share'); go('send')`); await snap('send-sharing');
    await run(`sa.shareStop()`);
    await run(`go('settings'); document.getElementById('content').scrollTop = 500`); await snap('settings-transfers');
  } catch (e) {
    fs.writeFileSync(path.join(dir, 'error.txt'), String(e.stack || e));
  }
  fs.writeFileSync(path.join(dir, 'console-errors.txt'), errors.join('\n'));
  done();
};
