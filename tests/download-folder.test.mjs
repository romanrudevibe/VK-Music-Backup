import test from 'node:test';
import assert from 'node:assert/strict';
import {openDownloadedFolder} from '../extension/download-folder.js';

test('Folder action selects only completed existing music of the current account and extension',async()=>{
  const calls=[];
  const entries=[
    {id:1,filename:'/Downloads/VK Audio/123/other.mp3',byExtensionId:'other',state:'complete',exists:true},
    {id:2,filename:'/Downloads/VK Audio/1234/other.mp3',byExtensionId:'ours',state:'complete',exists:true},
    {id:3,filename:'/Downloads/VK Audio/123/deleted.mp3',byExtensionId:'ours',state:'complete',exists:false},
    {id:4,filename:'/Downloads/VK Audio/123/active.mp3',byExtensionId:'ours',state:'in_progress',exists:true},
    {id:5,filename:'C:\\Downloads\\VK Audio\\123\\music.m4a',byExtensionId:'ours',state:'complete',exists:true},
    {id:6,filename:'/Downloads/VK Audio/123/older.mp3',byExtensionId:'ours',state:'complete',exists:true},
  ];
  globalThis.chrome={runtime:{id:'ours'},downloads:{
    search:async q=>{
      assert.deepEqual(q.orderBy,['-startTime']);
      assert.equal(q.limit,0);
      const re=new RegExp(q.filenameRegex);
      return entries.filter(d=>re.test(d.filename)&&d.state===q.state&&d.exists===q.exists);
    },
    show:id=>calls.push(id),showDefaultFolder:()=>calls.push('default'),
  }};
  assert.deepEqual(await openDownloadedFolder('123'),{found:true});
  assert.deepEqual(calls,[5]);
  entries.length=0;
  assert.deepEqual(await openDownloadedFolder('123'),{found:false});
  assert.deepEqual(calls,[5,'default']);
});

test('Without a valid account the folder action opens Downloads without searching unrelated history',async()=>{
  let opens=0;
  globalThis.chrome={downloads:{search:()=>assert.fail('Unexpected history search'),showDefaultFolder:()=>opens++}};
  for(const account of [undefined,null,'','123|456']) {
    assert.deepEqual(await openDownloadedFolder(account),{found:false});
  }
  assert.equal(opens,4);
});
