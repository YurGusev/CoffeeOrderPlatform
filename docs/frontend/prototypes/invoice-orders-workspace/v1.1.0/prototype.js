const $=selector=>document.querySelector(selector);
const $$=selector=>[...document.querySelectorAll(selector)];
const money=value=>new Intl.NumberFormat('ru-RU',{style:'currency',currency:'RUB',maximumFractionDigits:0}).format(value);

const catalog=[
  {id:1,name:'Эфиопия Гуджи',sku:'AR-1042',price:790,pack:'1 кг',stock:'В наличии'},
  {id:2,name:'Бразилия Сантос',sku:'AR-2210',price:620,pack:'1 кг',stock:'В наличии'},
  {id:3,name:'Колумбия Уила',sku:'AR-3048',price:720,pack:'1 кг',stock:'В наличии'},
  {id:4,name:'Колумбия без кофеина',sku:'AR-7701',price:890,pack:'500 г',stock:'Осталось 4'},
  {id:5,name:'Матча Удзи',sku:'AR-9130',price:1490,pack:'100 г',stock:'В наличии'},
  {id:6,name:'Фильтры Hario V60 02',sku:'AR-6202',price:490,pack:'100 шт.',stock:'В наличии'},
  {id:7,name:'Кения Кириньяга',sku:'AR-5081',price:860,pack:'1 кг',stock:'В наличии'},
  {id:8,name:'Дрип-пакеты Эфиопия',sku:'AR-8124',price:680,pack:'10 шт.',stock:'В наличии'}
];
const cloneItems=ids=>ids.map(([id,qty])=>({...catalog.find(item=>item.id===id),qty}));
const orders=[
  {id:4871,customer:'Анна Смирнова',phone:'+7 916 245-18-04',company:'Кофейня «Точка»',invoice:null,date:'14.09.2026',status:'draft',payment:'Не требуется',aroma:'NotRequested',items:cloneItems([[1,4],[2,3],[3,2],[4,1],[5,2],[6,3]])},
  {id:4868,customer:'Михаил Орлов',phone:'+7 903 112-44-20',company:'ООО «Север»',invoice:'A-62418',date:'14.09.2026',status:'confirmed',payment:'Ждёт оплату',aroma:'PendingObservation',items:cloneItems([[2,2],[7,3],[6,1]])},
  {id:4852,customer:'Михаил Орлов',phone:'+7 903 112-44-20',company:'ООО «Север»',invoice:'A-62418',date:'12.09.2026',status:'confirmed',payment:'Ждёт оплату',aroma:'InSync',items:cloneItems([[1,5],[2,5],[3,2]])},
  {id:4864,customer:'Мария Соколова',phone:'+7 985 603-02-19',company:'Студия «Лён»',invoice:'A-62407',date:'13.09.2026',status:'blocked',payment:'Не оплачено',aroma:'Blocked',items:cloneItems([[1,2],[3,4],[4,2],[8,3]])},
  {id:4859,customer:'Илья Воронцов',phone:'+7 916 880-11-92',company:'Бар «Причал»',invoice:'A-62398',date:'13.09.2026',status:'confirmed',payment:'Оплачено',aroma:'InSync',items:cloneItems([[2,8],[6,4]])},
  {id:4856,customer:'Елена Миронова',phone:'+7 901 770-32-11',company:'Кофейня «Среда»',invoice:'A-62371',date:'12.09.2026',status:'draft',payment:'Не выставлен',aroma:'NotRequested',items:cloneItems([[5,2],[8,6]])}
];
const invoiceMeta={
  '__none__':{label:'Без счёта',status:'Черновики',tone:'neutral',payment:'Оплата не запрошена'},
  'A-62418':{label:'Счёт A-62418',status:'Выставлен',tone:'primary',payment:'Ждёт оплату'},
  'A-62407':{label:'Счёт A-62407',status:'Требует внимания',tone:'danger',payment:'Не оплачено'},
  'A-62398':{label:'Счёт A-62398',status:'Оплачен',tone:'success',payment:'Оплачено'},
  'A-62371':{label:'Счёт A-62371',status:'Черновик',tone:'neutral',payment:'Не выставлен'}
};
const invoiceKey=order=>order.invoice||'__none__';
const statusLabel={draft:'Черновик',confirmed:'Подтверждён',blocked:'Стоп'};
const statusTone={draft:'primary',confirmed:'success',blocked:'danger'};
const aromaLabel={NotRequested:'Не запрошена',PendingObservation:'Ожидает сверки',OutOfSync:'Не совпадает',Converging:'Сводится',InSync:'В корзине',Blocked:'Стоп',UnknownOutcome:'Неизвестно'};
const aromaTone={NotRequested:'neutral',PendingObservation:'primary',OutOfSync:'warning',Converging:'primary',InSync:'success',Blocked:'danger',UnknownOutcome:'warning'};
const allInvoiceKeys=[...new Set(orders.map(invoiceKey))];
const openInvoices=new Set(allInvoiceKeys);
let openId=null;
let view='all';
let edit=null;
let drawerReturn=null;
let removed=null;

const total=order=>order.items.reduce((sum,item)=>sum+item.price*item.qty,0);
const units=order=>order.items.reduce((sum,item)=>sum+item.qty,0);
const invoiceTotal=group=>group.orders.reduce((sum,order)=>sum+total(order),0);
const iconChevron=(expanded,className='x-chevron')=>`<svg class="x-icon ${className}" data-expanded="${expanded}" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>`;

function visibleOrders(){
  const query=$('#search').value.trim().toLowerCase();
  const customerQuery=$('#customer').value.trim().toLowerCase();
  const status=$('#status').value;
  return orders.filter(order=>{
    const haystack=[order.id,order.customer,order.phone,order.company,order.invoice||'без счёта',...order.items.map(item=>`${item.name} ${item.sku}`)].join(' ').toLowerCase();
    const customer=[order.customer,order.phone,order.company].join(' ').toLowerCase();
    const viewMatches=view==='all'||view==='drafts'&&order.status==='draft'||view==='stopped'&&order.status==='blocked'||view==='payments'&&order.payment==='Ждёт оплату'||view==='today'&&order.date==='14.09.2026';
    return haystack.includes(query)&&customer.includes(customerQuery)&&(!status||order.status===status)&&viewMatches;
  });
}

function invoiceGroups(list){
  const map=new Map();
  for(const order of list){
    const key=invoiceKey(order);
    if(!map.has(key))map.set(key,{key,meta:invoiceMeta[key],orders:[]});
    map.get(key).orders.push(order);
  }
  return [...map.values()];
}

function invoiceGroupRow(group,forceExpanded){
  const expanded=forceExpanded||openInvoices.has(group.key);
  const customers=[...new Set(group.orders.map(order=>order.customer))];
  const customerCopy=customers.length===1?customers[0]:`${customers.length} заказчика`;
  return `<tr class="orders-table_invoiceGroupRow ${expanded?'orders-table_invoiceGroupRowExpanded':''}" data-ui="invoice-group-row" data-invoice-ref="${group.key}"><td colspan="11"><button class="orders-table_invoiceGroupButton" type="button" data-ui="invoice-group-toggle" data-invoice-toggle="${group.key}" aria-expanded="${expanded}">
    <span class="orders-table_invoiceGroupSummary">${iconChevron(expanded,'orders-table_invoiceGroupChevron')}<span class="orders-table_invoiceGroupTitle">${group.meta.label}</span><span class="ui-status_badge" data-size="sm" data-tone="${group.meta.tone}" data-variant="soft">${group.meta.status}</span><span class="x-invoice-subtitle">${group.orders.length} ${group.orders.length===1?'заказ':'заказа'} · ${customerCopy}</span></span>
    <span class="x-invoice-meta"><span class="orders-table_paymentState">${group.meta.payment}</span><span class="orders-table_invoiceGroupTotal">${money(invoiceTotal(group))}</span></span>
  </button></td></tr>`;
}

function orderRow(order){
  const expanded=openId===order.id;
  return `<tr class="orders-table_orderRow orders-table_orderRowGrouped orders-table_orderRowInteractive ${expanded?'orders-table_orderRowExpanded':''} x-order-row" tabindex="0" data-ui="order-row" data-order="${order.id}" data-invoice-ref="${invoiceKey(order)}" data-order-status="${order.status}" aria-expanded="${expanded}">
    <td data-column-id="expand"><button class="orders-table_tableIconButton x-chevron-button" data-toggle="${order.id}" aria-label="${expanded?'Свернуть':'Раскрыть'} заказ ${order.id}">${iconChevron(expanded,'orders-table_orderChevron')}</button></td>
    <td data-column-id="select"><input class="orders-table_selectionCheckbox" type="checkbox" aria-label="Выбрать заказ ${order.id}"></td>
    <td data-column-id="id"><span class="orders-table_orderIdentifier">#${order.id}</span></td>
    <td><span class="orders-table_customerName">${order.customer}</span><span class="orders-table_secondaryText orders-table_cellTruncate">${order.company} · ${order.phone}</span></td>
    <td>${order.date}</td><td class="orders-table_numeric x-right">${order.items.length}</td><td class="orders-table_numeric x-right">${units(order)}</td><td class="orders-table_numeric orders-table_total x-right">${money(total(order))}</td>
    <td><span class="ui-status_badge" data-size="sm" data-tone="${statusTone[order.status]}" data-variant="soft">${statusLabel[order.status]}</span></td>
    <td><span class="ui-status_badge" data-size="sm" data-tone="${aromaTone[order.aroma]}" data-variant="soft">${aromaLabel[order.aroma]}</span></td>
    <td><button class="ui-action_button" data-size="sm" data-variant="soft" data-ui="open-order-workflow" data-workflow="${order.id}">Карточка заказа</button></td>
  </tr>${expanded?expandedRow(order):''}`;
}

function expandedRow(order){
  const invoice=invoiceMeta[invoiceKey(order)];
  return `<tr data-ui="expanded-order-row" data-order-details="${order.id}"><td class="orders-table_inlineCell" colspan="11"><section class="orders-table_inlinePanel x-inline-panel" data-ui="order-composer" aria-label="Состав заказа ${order.id}">
    <div class="x-inline-header"><div class="x-inline-meta"><div class="x-flex"><h3 class="ui-text_heading" data-level="3">Состав заказа #${order.id}</h3><span class="ui-status_badge" data-size="sm" data-tone="${statusTone[order.status]}" data-variant="soft">${statusLabel[order.status]}</span></div><p class="ui-text_text" data-size="caption" data-tone="neutral">${invoice.label} · ${order.items.length} поз. · ${units(order)} ед. · ${order.customer}</p></div>
    <div class="x-inline-actions"><button class="ui-action_button" data-size="sm" data-variant="soft" data-ui="add-order-item" data-add="${order.id}">＋ Добавить товар</button><button class="ui-action_button" data-size="sm" data-variant="soft" data-ui="open-order-workflow" data-workflow="${order.id}">Корзина и счёт</button><button class="ui-action_button" data-size="sm" data-variant="ghost" data-toggle="${order.id}">Свернуть</button></div></div>
    <div class="orders-table_itemsScroller" data-ui="order-items-scroll"><table class="orders-table_itemsTable orders-table_inlineItemsTable x-items-table" data-ui="order-items"><colgroup><col><col><col><col><col></colgroup><thead><tr><th>Товар</th><th class="x-right">Цена</th><th>Количество</th><th class="x-right">Сумма</th><th>Действия</th></tr></thead><tbody>${order.items.map(item=>itemRow(order,item)).join('')}</tbody></table></div>
    <div class="x-items-scroll-hint" data-ui="items-scroll-hint" role="status" hidden><span data-items-scroll-copy>Ниже ещё товары</span><button class="ui-action_button" data-size="sm" data-variant="link" type="button" data-items-scroll-more data-scroll-state="more">Показать следующие</button></div>
    <div class="x-inline-footer" data-ui="order-summary"><div class="x-total"><small>Итого по заказу</small><strong>${money(total(order))}</strong></div><div class="x-inline-actions"><span class="ui-text_text" data-size="caption" data-tone="neutral">Изменения сохраняются только в этом заказе</span><button class="ui-action_button" data-size="sm" data-variant="solid" data-ui="confirm-order" data-confirm="${order.id}" ${order.status!=='draft'?'disabled':''}>${order.status==='draft'?'Подтвердить заказ':'Заказ подтверждён'}</button></div></div>
  </section></td></tr>`;
}

function itemRow(order,item){
  return `<tr data-ui="order-item" data-item="${item.id}"><td><span class="x-product-copy"><strong>${item.name}</strong><small>${item.sku} · ${item.pack} · ${item.stock}</small></span></td><td class="orders-table_numeric x-right">${money(item.price)}</td><td><span class="x-quantity" data-ui="quantity-control"><button data-step="-1" data-order-id="${order.id}" data-item-id="${item.id}" aria-label="Уменьшить ${item.name}">−</button><input value="${item.qty}" inputmode="numeric" data-qty data-order-id="${order.id}" data-item-id="${item.id}" aria-label="Количество ${item.name}"><button data-step="1" data-order-id="${order.id}" data-item-id="${item.id}" aria-label="Увеличить ${item.name}">＋</button></span></td><td class="orders-table_numeric orders-table_total x-right">${money(item.price*item.qty)}</td><td><span class="x-inline-actions"><button class="ui-action_button" data-size="sm" data-variant="soft" data-ui="edit-order-item" data-edit="${order.id}:${item.id}">Изменить</button><button class="ui-action_button" data-size="sm" data-variant="ghost" data-ui="remove-order-item" data-remove="${order.id}:${item.id}">Удалить</button></span></td></tr>`;
}

function render(){
  const list=visibleOrders();
  const groups=invoiceGroups(list);
  const filterActive=Boolean($('#search').value.trim()||$('#customer').value.trim()||$('#status').value||view!=='all');
  $('#orders-body').innerHTML=groups.length?groups.map(group=>{
    const expanded=filterActive||openInvoices.has(group.key);
    return invoiceGroupRow(group,filterActive)+(expanded?group.orders.map(order=>orderRow(order)).join(''):'');
  }).join(''):`<tr><td colspan="11"><section class="orders-table_inlinePanel"><h3 class="ui-text_heading" data-level="3">Счета и заказы не найдены</h3><p class="ui-text_text" data-tone="neutral">Измените условия поиска.</p></section></td></tr>`;
  $('#invoice-count').textContent=groups.length;
  $('#total-count').textContent=list.length;
  $('#range').textContent=`Показано ${groups.length} ${groups.length===1?'счёт':'счетов'} · ${list.length} ${list.length===1?'заказ':'заказов'}`;
  requestAnimationFrame(()=>{fitInlinePanel();updateRegistryScrollHint();});
}

function fitInlinePanel(){
  const panel=$('.x-inline-panel');
  const registryScroller=$('.orders-table_tableScroller');
  if(!panel||!registryScroller)return;
  const itemsScroller=panel.querySelector('.orders-table_itemsScroller');
  const itemsTable=itemsScroller?.querySelector('table');
  const itemsHint=panel.querySelector('.x-items-scroll-hint');
  if(!itemsScroller||!itemsTable||!itemsHint)return;

  panel.style.height='auto';
  panel.style.maxHeight='none';
  itemsHint.hidden=true;
  const available=Math.max(0,Math.floor(registryScroller.getBoundingClientRect().bottom-panel.getBoundingClientRect().top-8));
  const naturalPanelHeight=Math.ceil(panel.getBoundingClientRect().height);

  if(naturalPanelHeight<=available){
    panel.style.height=`${naturalPanelHeight}px`;
    itemsScroller.onscroll=null;
    return;
  }

  itemsHint.hidden=false;
  const naturalItemsHeight=Math.ceil(itemsTable.getBoundingClientRect().height);
  const naturalWithHint=Math.ceil(panel.getBoundingClientRect().height);
  const chromeHeight=naturalWithHint-naturalItemsHeight;
  const headHeight=Math.ceil(itemsTable.tHead?.getBoundingClientRect().height||0);
  const rowHeights=[...itemsTable.tBodies[0].rows].map(row=>Math.ceil(row.getBoundingClientRect().height));
  const itemBudget=Math.max(0,available-chromeHeight);
  let snappedItemsHeight=Math.min(headHeight,itemBudget);
  let fullRows=0;
  for(const rowHeight of rowHeights){
    if(snappedItemsHeight+rowHeight>itemBudget)break;
    snappedItemsHeight+=rowHeight;
    fullRows++;
  }
  const fittedHeight=Math.min(available,Math.ceil(chromeHeight+Math.min(naturalItemsHeight,snappedItemsHeight)));
  panel.style.height=`${fittedHeight}px`;
  itemsScroller.onscroll=()=>updateItemsScrollHint(panel);
  requestAnimationFrame(()=>updateItemsScrollHint(panel));
}
function updateItemsScrollHint(panel=$('.x-inline-panel')){
  if(!panel)return;
  const scroller=panel.querySelector('.orders-table_itemsScroller');
  const hint=panel.querySelector('.x-items-scroll-hint');
  const button=hint?.querySelector('[data-items-scroll-more]');
  const copy=hint?.querySelector('[data-items-scroll-copy]');
  if(!scroller||!hint||!button||!copy||hint.hidden)return;
  const atEnd=scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-2;
  button.dataset.scrollState=atEnd?'end':'more';
  button.textContent=atEnd?'К началу':'Показать следующие';
  copy.textContent=atEnd?'Показаны последние позиции':'Ниже ещё товары заказа';
}
function updateRegistryScrollHint(){
  const scroller=$('.orders-table_tableScroller');
  const hint=$('#registry-scroll-hint');
  const button=hint?.querySelector('[data-registry-scroll-more]');
  const sideButton=hint?.querySelector('[data-registry-scroll-side]');
  const copy=$('#registry-scroll-copy');
  if(!scroller||!hint||!button||!sideButton||!copy)return;
  const verticalOverflow=scroller.scrollHeight>scroller.clientHeight+2;
  const horizontalOverflow=scroller.scrollWidth>scroller.clientWidth+2;
  hint.hidden=!verticalOverflow&&!horizontalOverflow;
  button.hidden=!verticalOverflow;
  sideButton.hidden=!horizontalOverflow;
  if(hint.hidden)return;
  const verticalEnd=!verticalOverflow||scroller.scrollTop+scroller.clientHeight>=scroller.scrollHeight-2;
  const horizontalEnd=!horizontalOverflow||scroller.scrollLeft+scroller.clientWidth>=scroller.scrollWidth-2;
  button.dataset.scrollState=verticalEnd?'end':'more';
  button.textContent=verticalEnd?'К началу списка':'Показать остальные';
  sideButton.dataset.scrollState=horizontalEnd?'end':'more';
  sideButton.textContent=horizontalEnd?'К началу таблицы':'Показать статусы и действия';
  const parts=[];
  if(verticalOverflow)parts.push(verticalEnd?'Показаны последние счета и заказы':'Ниже ещё счета и заказы');
  if(horizontalOverflow)parts.push(horizontalEnd?'Показаны правые колонки':'Справа ещё статусы, корзина и действия');
  copy.textContent=parts.join(' · ');
}
function findOrder(id){return orders.find(order=>order.id===Number(id));}
function findItem(order,id){return order.items.find(item=>item.id===Number(id));}
function showSaved(){const state=$('#saved-state');state.hidden=false;clearTimeout(showSaved.timer);showSaved.timer=setTimeout(()=>state.hidden=true,1600);}
function setQty(orderId,itemId,value){const order=findOrder(orderId),item=findItem(order,itemId);item.qty=Math.max(1,Math.min(999,Number(value)||item.qty));render();showSaved();requestAnimationFrame(()=>document.querySelector(`[data-qty][data-order-id="${orderId}"][data-item-id="${itemId}"]`)?.focus());}
function toggleOrder(id){const order=findOrder(id);openInvoices.add(invoiceKey(order));openId=openId===Number(id)?null:Number(id);render();requestAnimationFrame(()=>{const row=document.querySelector(`tr[data-order="${id}"]`),scroller=$('.orders-table_tableScroller');if(openId===Number(id)&&row&&scroller)scroller.scrollTop=Math.max(0,row.offsetTop);fitInlinePanel();updateRegistryScrollHint();document.querySelector(`[data-toggle="${id}"]`)?.focus();});}
function toggleInvoice(key){openInvoices.has(key)?openInvoices.delete(key):openInvoices.add(key);render();requestAnimationFrame(()=>document.querySelector(`[data-invoice-toggle="${key}"]`)?.focus());}
function openDrawer(title,body,footer,trigger){drawerReturn=trigger;$('#drawer-title').textContent=title;$('#drawer-body').innerHTML=body;$('#drawer-footer').innerHTML=footer;$('#drawer-view').hidden=false;requestAnimationFrame(()=>( $('#drawer-body').querySelector('input,select,button')||$('#drawer-view').querySelector('button'))?.focus());}
function closeDrawer(){if($('#drawer-view').hidden)return;$('#drawer-view').hidden=true;$('#drawer-body').innerHTML='';$('#drawer-footer').innerHTML='';drawerReturn?.focus();}
function openEdit(orderId,itemId,trigger){const order=findOrder(orderId),item=findItem(order,itemId);edit={orderId:order.id,itemId:item.id};openDrawer('Редактировать товар',`<form class="x-drawer-form" id="edit-form"><label class="ui-field_field"><span class="ui-text_label">Товар</span><select class="ui-select_select" id="edit-product">${catalog.map(product=>`<option value="${product.id}" ${product.id===item.id?'selected':''}>${product.name} · ${product.pack}</option>`).join('')}</select><span class="ui-field_description">Цена берётся из каталога</span></label><label class="ui-field_field"><span class="ui-text_label">Количество</span><input class="ui-field_input" id="edit-qty" type="number" min="1" max="999" value="${item.qty}"></label><div class="orders-workspace_summaryCard"><span class="orders-workspace_summaryLabel">Текущая сумма строки</span><div class="orders-workspace_summaryValue">${money(item.price*item.qty)}</div></div></form>`,`<button class="ui-action_button" data-variant="ghost" data-close>Отмена</button><button class="ui-action_button" data-variant="solid" id="save-edit">Сохранить</button>`,trigger);}
function openCatalog(orderId,trigger){edit={orderId:Number(orderId),mode:'add'};openDrawer('Добавить товар',`<label class="ui-field_field"><span class="ui-text_label">Поиск по каталогу</span><input class="ui-field_input" id="catalog-search" placeholder="Название или артикул"></label><div class="x-catalog-list" id="catalog-list"></div>`,`<button class="ui-action_button" data-variant="ghost" data-close>Закрыть</button>`,trigger);renderCatalog();}
function renderCatalog(){const order=findOrder(edit.orderId),query=($('#catalog-search')?.value||'').toLowerCase();$('#catalog-list').innerHTML=catalog.filter(product=>(product.name+' '+product.sku).toLowerCase().includes(query)).map(product=>`<div class="x-catalog-item"><span><strong>${product.name}</strong><small>${product.sku} · ${product.pack} · ${money(product.price)}</small></span><button class="ui-action_button" data-size="sm" data-variant="soft" data-catalog-add="${product.id}">${order.items.some(item=>item.id===product.id)?'Добавить ещё':'Добавить'}</button></div>`).join('');}
function openWorkflow(orderId,trigger){const order=findOrder(orderId),invoice=invoiceMeta[invoiceKey(order)];openDrawer(`Заказ #${order.id}`,`<div class="x-drawer-form"><div class="orders-workspace_summaryCard"><span class="orders-workspace_summaryLabel">Корзина AROMA</span><div class="orders-workspace_summaryValue">${aromaLabel[order.aroma]}</div></div><div class="orders-workspace_summaryCard"><span class="orders-workspace_summaryLabel">Привязка к счёту</span><div class="orders-workspace_summaryValue">${invoice.label}</div></div><div class="orders-workspace_summaryCard"><span class="orders-workspace_summaryLabel">Статус счёта</span><div class="orders-workspace_summaryValue">${invoice.status}</div></div><div class="orders-workspace_summaryCard"><span class="orders-workspace_summaryLabel">Оплата</span><div class="orders-workspace_summaryValue">${invoice.payment}</div></div><p class="ui-text_text" data-tone="neutral">Счёт группирует заказы. Товары изменяются только внутри выбранного заказа.</p></div>`,`<button class="ui-action_button" data-variant="solid" data-close>Готово</button>`,trigger);}
function removeItem(orderId,itemId){const order=findOrder(orderId),index=order.items.findIndex(item=>item.id===Number(itemId));removed={orderId:order.id,index,item:order.items[index]};order.items.splice(index,1);render();$('#toast-text').textContent='Товар удалён из заказа';$('#undo').hidden=false;$('#toast').hidden=false;showSaved();}
function toast(text){$('#toast-text').textContent=text;$('#undo').hidden=true;$('#toast').hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').hidden=true,2200);}

document.addEventListener('click',event=>{
  const closeTarget=event.target.closest?.('[data-close]');
  if(closeTarget){closeDrawer();return;}
  const button=event.target.closest('button');
  if(!button||button.disabled)return;
  if(button.dataset.itemsScrollMore!==undefined){event.stopPropagation();const panel=button.closest('.x-inline-panel'),scroller=panel.querySelector('.orders-table_itemsScroller');scroller.scrollTo({top:button.dataset.scrollState==='end'?0:Math.min(scroller.scrollHeight,scroller.scrollTop+scroller.clientHeight),behavior:'auto'});updateItemsScrollHint(panel);}
  else if(button.dataset.registryScrollMore!==undefined){event.stopPropagation();const scroller=$('.orders-table_tableScroller');scroller.scrollTo({top:button.dataset.scrollState==='end'?0:scroller.scrollHeight,behavior:'auto'});updateRegistryScrollHint();}
  else if(button.dataset.registryScrollSide!==undefined){event.stopPropagation();const scroller=$('.orders-table_tableScroller');scroller.scrollTo({left:button.dataset.scrollState==='end'?0:scroller.scrollWidth,behavior:'auto'});updateRegistryScrollHint();}
  else if(button.dataset.invoiceToggle){event.stopPropagation();toggleInvoice(button.dataset.invoiceToggle);}
  else if(button.dataset.toggle){event.stopPropagation();toggleOrder(button.dataset.toggle);}
  else if(button.dataset.step){event.stopPropagation();const order=findOrder(button.dataset.orderId),item=findItem(order,button.dataset.itemId);setQty(order.id,item.id,item.qty+Number(button.dataset.step));}
  else if(button.dataset.edit){event.stopPropagation();const [orderId,itemId]=button.dataset.edit.split(':');openEdit(orderId,itemId,button);}
  else if(button.dataset.add){event.stopPropagation();openCatalog(button.dataset.add,button);}
  else if(button.dataset.workflow){event.stopPropagation();openWorkflow(button.dataset.workflow,button);}
  else if(button.dataset.remove){event.stopPropagation();const [orderId,itemId]=button.dataset.remove.split(':');removeItem(orderId,itemId);}
  else if(button.dataset.confirm){const order=findOrder(button.dataset.confirm);order.status='confirmed';order.aroma='PendingObservation';render();toast('Заказ подтверждён; корзина ожидает сверки');}
  else if(button.id==='save-edit'){const order=findOrder(edit.orderId),current=findItem(order,edit.itemId),selected=catalog.find(product=>product.id===Number($('#edit-product').value)),qty=Math.max(1,Math.min(999,Number($('#edit-qty').value)||1));const duplicate=order.items.find(item=>item.id===selected.id&&item.id!==current.id);if(duplicate){duplicate.qty+=qty;order.items=order.items.filter(item=>item!==current);}else Object.assign(current,selected,{qty});closeDrawer();render();showSaved();}
  else if(button.dataset.catalogAdd){const order=findOrder(edit.orderId),product=catalog.find(item=>item.id===Number(button.dataset.catalogAdd)),existing=findItem(order,product.id);if(existing)existing.qty++;else order.items.push({...product,qty:1});renderCatalog();render();toast(`${product.name} добавлен`);}
  else if(button.dataset.view){view=button.dataset.view;$$('[data-view]').forEach(item=>{item.classList.toggle('orders-workspace_savedViewButtonActive',item===button);item.setAttribute('aria-pressed',String(item===button));});openId=null;render();}
  else if(button.id==='refresh')toast('Демонстрационные данные обновлены');
  else if(button.id==='new-order')toast('Создание заказа будет отдельной формой');
  else if(button.id==='import')toast('Импорт в макете не подключён');
  const row=event.target.closest('tr[data-order]');
  if(row&&!event.target.closest('button,input,a,select'))toggleOrder(row.dataset.order);
});

document.addEventListener('keydown',event=>{
  const row=event.target.closest?.('tr[data-order]');
  if(row&&(event.key==='Enter'||event.key===' ')){event.preventDefault();toggleOrder(row.dataset.order);}
  if(event.key==='Escape'&&!$('#drawer-view').hidden){event.preventDefault();closeDrawer();}
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();$('#search').focus();}
});
document.addEventListener('change',event=>{if(event.target.matches('[data-qty]'))setQty(event.target.dataset.orderId,event.target.dataset.itemId,event.target.value);if(event.target.matches('#status')){openId=null;render();}});
document.addEventListener('input',event=>{if(event.target.matches('#search,#customer')){openId=null;render();}if(event.target.matches('#catalog-search'))renderCatalog();});
$('.orders-table_tableScroller').addEventListener('scroll',updateRegistryScrollHint,{passive:true});
window.addEventListener('resize',()=>requestAnimationFrame(()=>{fitInlinePanel();updateRegistryScrollHint();}));
$('#undo').addEventListener('click',()=>{if(!removed)return;findOrder(removed.orderId).items.splice(removed.index,0,removed.item);openId=removed.orderId;openInvoices.add(invoiceKey(findOrder(removed.orderId)));removed=null;$('#toast').hidden=true;render();});
render();
