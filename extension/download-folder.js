export async function openDownloadedFolder(account) {
  if (typeof account==='string' && /^\d+$/.test(account)) {
    const filenameRegex=`[/\\\\]VK Audio[/\\\\]${account}[/\\\\][^/\\\\]+\\.(mp3|m4a)$`;
    const items=await chrome.downloads.search({filenameRegex,state:'complete',exists:true,orderBy:['-startTime'],limit:0});
    const item=items.find(d=>d.byExtensionId===chrome.runtime.id);
    if(item) {
      chrome.downloads.show(item.id);
      return {found:true};
    }
  }
  chrome.downloads.showDefaultFolder();
  return {found:false};
}
