import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// External knowledge is untrusted content: no HTML, embeds, tools or automatic remote image requests.
export function WikiMarkdown({body}:{body:string}) {
  return <div className="retail-wiki-markdown"><ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={url=>/^https:\/\//i.test(url)||/^data:image\/(png|jpeg|webp);base64,[a-zA-Z0-9+/=]+$/.test(url)?url:''} components={{
    a:({href,children})=><a href={href} onClick={event=>{event.preventDefault();if(href?.startsWith('https://'))void window.electronAPI.openUrl(href);}}>{children}</a>,
    img:({src,alt})=>src?.startsWith('data:image/')?<img src={src} alt={alt??'知识插图'}/>:<span className="retail-muted">图片：{alt||'外部图片'}（未自动加载）{src&&<button onClick={()=>void window.electronAPI.openUrl(src)}>打开图片来源</button>}</span>,
  }}>{body}</ReactMarkdown></div>;
}
