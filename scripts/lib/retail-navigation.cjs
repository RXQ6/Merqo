// Existing business acceptance flows navigate through the product's function search.
const names=new Map(['库存与补货','广告经营','交易与退款','异常中心','业务实体','调查记录','经营巡检','业务任务','复查与提醒','决策草稿','审批中心','执行记录','补偿记录','经营知识中心','经营复盘','平台接入','数据与导入','商品映射','经营规则','经营助手','批量执行'].map(s=>[s,s]));
names.set('经营知识库','经营知识中心');names.set('经营总览','总览');
function retailButton(page,name){
  const locator=page.getByRole('button',{name,exact:true});
  if(!names.has(name))return locator;
  return new Proxy(locator,{get(target,property){
    if(property==='click')return async options=>{
      const search=page.getByRole('button',{name:'打开功能搜索',exact:true});
      if(!await search.count())return target.click(options);
      await search.click();const dialog=page.getByRole('dialog',{name:'查找经营功能'});
      await dialog.getByLabel('搜索经营功能',{exact:true}).fill(names.get(name));
      await dialog.getByRole('button',{name:new RegExp('^'+names.get(name))}).click(options);
    };
    const value=Reflect.get(target,property);return typeof value==='function'?value.bind(target):value;
  }});
}
module.exports={retailButton};
