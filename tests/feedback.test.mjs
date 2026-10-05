import test from 'node:test';
import assert from 'node:assert/strict';
import {issueDraft,issueURL} from '../extension/feedback.js';
test('Feedback draft excludes account, tracks and response details; URL safely encodes editable text',()=>{
 const body=issueDraft('0.1.16',{code:'VK',message:'SECRET',diagnostics:['SECRET']});
 assert.ok(body.includes('0.1.16'));assert.ok(body.includes('Код ошибки: VK'));assert.ok(!body.includes('SECRET'));
 const url=new URL(issueURL('https://github.com/roman/project',body));
 assert.equal(url.pathname,'/roman/project/issues/new');assert.equal(url.searchParams.get('body'),body);
 assert.equal(issueURL('https://example.com/repo',body),null);assert.equal(issueURL('',body),null);
});
