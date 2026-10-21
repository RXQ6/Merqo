export function ModuleNavigation({items}:{items:Array<{label:string;region:string}>}){
 return <nav className="retail-module-nav" aria-label="当前页面功能定位">
  <span>本页功能</span>
  {items.map(item=><button key={item.region} onClick={event=>{
   const root=event.currentTarget.closest('[data-testid="retail-signals"], [data-testid="retail-transactions"]');
   const regions=root?Array.from(root.querySelectorAll<HTMLElement>('[aria-label]')):[];
   const region=regions.find(el=>el.getAttribute('aria-label')===item.region);
   const scroller=root?.closest<HTMLElement>('.retail-main');
   if(region&&scroller){const offset=region.getBoundingClientRect().top-scroller.getBoundingClientRect().top;scroller.scrollTo({top:scroller.scrollTop+offset-event.currentTarget.parentElement!.offsetHeight-12,behavior:'instant'});}
  }}>{item.label}</button>)}
 </nav>;
}
