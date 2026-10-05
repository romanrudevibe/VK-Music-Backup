fetch('/config.json').then(r=>r.json()).then(config=>{
 if(/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(config.repository_url)){
  const link=document.getElementById('feedback');link.href=config.repository_url+'/issues';link.hidden=false;
 }
}).catch(()=>{});
