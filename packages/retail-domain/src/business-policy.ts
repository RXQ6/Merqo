import {z} from 'zod';

export const RuleSettingsSchema=z.strictObject({
 marginFloorBps:z.number().int().min(0).max(9000),marginMinUnits:z.number().int().min(0).max(1000000000),
 salesDropBps:z.number().int().min(1).max(10000),stockBufferDays:z.number().int().min(0).max(30),minInventorySales:z.number().int().min(0).max(1000000000),
 adsRoasDropBps:z.number().int().min(1).max(10000),minAdsClicks:z.number().int().min(0).max(1000000000),
 inventoryWindowDays:z.number().int().min(1).max(90).nullable(),adsWindowDays:z.number().int().min(1).max(90).nullable(),
 approvalMinutes:z.number().int().min(1).max(1440),priceChangeLimitBps:z.number().int().min(1).max(5000),
});
export type RuleSettings=z.infer<typeof RuleSettingsSchema>;
export const DEFAULT_RULE_SETTINGS:RuleSettings={marginFloorBps:2000,marginMinUnits:0,salesDropBps:2000,stockBufferDays:2,minInventorySales:0,adsRoasDropBps:2000,minAdsClicks:0,inventoryWindowDays:null,adsWindowDays:null,approvalMinutes:30,priceChangeLimitBps:2000};
export const PolicyDocumentSchema=z.strictObject({schemaVersion:z.literal(1),revision:z.number().int().min(0),defaultSettings:RuleSettingsSchema,shops:z.array(z.strictObject({shopId:z.string().trim().min(1).max(100),settings:RuleSettingsSchema})).max(100),at:z.string().datetime().nullable(),reason:z.string().max(2000),actor:z.enum(['builtin','local-simulation-admin'])});
export type BusinessPolicy=z.infer<typeof PolicyDocumentSchema>;
export type FrozenPolicy={revision:number;settings:RuleSettings};
export const initialPolicy=():BusinessPolicy=>({schemaVersion:1,revision:0,defaultSettings:{...DEFAULT_RULE_SETTINGS},shops:[],at:null,reason:'版本化内置演示规则',actor:'builtin'});
export function freezePolicy(policy:BusinessPolicy,shop:string):FrozenPolicy{return{revision:policy.revision,settings:policy.shops.find(s=>s.shopId===shop)?.settings??policy.defaultSettings};}
export const policyRuleVersion=(base:string,revision:number):string=>revision?`${base}@policy:${revision}`:base;
export const PolicyUpdateSchema=z.strictObject({op:z.literal('policy_update'),expectedRevision:z.number().int().min(0),shopId:z.string().trim().min(1).max(100).nullable(),settings:RuleSettingsSchema,reason:z.string().trim().min(1).max(2000)});
export interface PolicyView {current:BusinessPolicy;history:BusinessPolicy[]}
