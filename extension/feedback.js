export function issueDraft(version,error) {
  const code=error?.code||'нет кода';
  return `Версия расширения: ${version}\nСистема и браузер: \n\nЧто перестало работать:\n\nКак повторить:\n\nКод ошибки: ${code}\n\nПри необходимости прикрепите файл vk-music-diagnostic.json. Проверьте содержимое перед публикацией: GitHub Issues видны всем. Не прикладывайте аудио, cookies или данные входа.`;
}
export function issueURL(repository,body) {
  if(!/^https:\/\/github\.com\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(repository))return null;
  const url=new URL(repository+'/issues/new');
  url.searchParams.set('title','Расширение перестало работать');
  url.searchParams.set('body',body);return url.href;
}
