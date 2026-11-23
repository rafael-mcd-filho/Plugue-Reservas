import { describe, expect, it } from 'vitest';
import { getSettlementPanelAccess } from './reservation-settlement-access';
import type { ImpersonationSession } from './impersonationSession';
const session: ImpersonationSession = {
  actorUserId:'platform-owner',companyId:'company-a',companySlug:'casa',companyName:'Casa',
  userId:'company-admin',userName:'Administrador',userEmail:'admin@example.invalid',
  effectiveRole:'admin',status:'active',startedAt:'2026-11-08T12:00:00Z',
};
const access = (overrides: Partial<Parameters<typeof getSettlementPanelAccess>[0]> = {}) => getSettlementPanelAccess({ companyId:'company-a',roles:['superadmin'],userId:'platform-owner',session,...overrides });
describe('settlement panel access',()=>{
  it('permits the real superadmin to operate as the selected company administrator',()=>{
    expect(access()).toEqual({canRead:true,canWrite:true,isLoading:false});
  });
  it('allows a direct company administrator and a direct superadmin',()=>{
    expect(access({roles:['admin'],session:null})).toEqual({canRead:true,canWrite:true,isLoading:false});
    expect(access({session:null})).toEqual({canRead:true,canWrite:true,isLoading:false});
  });
  it('does not treat support delegation or a forged local marker as superadmin authority',()=>{
    for(const input of [
      {roles:['support']}, {roles:['admin']}, {userId:'other-actor'}, {companyId:'company-b'},
      {session:{...session,supportSessionId:'support-session'}}, {session:{...session,effectiveRole:'operator' as const}},
    ]) expect(access(input)).toEqual({canRead:false,canWrite:false,isLoading:false});
  });
  it('waits for authentication and matching superadmin session activation',()=>{
    expect(access({session:{...session,status:'pending'}})).toEqual({canRead:false,canWrite:false,isLoading:true});
    expect(access({loading:true})).toEqual({canRead:false,canWrite:false,isLoading:true});
  });
});
