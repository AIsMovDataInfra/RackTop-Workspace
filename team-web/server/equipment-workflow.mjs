import { ApiError } from './store.mjs';

export function validateEquipmentTarget({ db, equipmentId, company, category }) {
  const item = db.prepare('SELECT id,name,serial_number,company,category,status FROM equipment WHERE id=?').get(equipmentId);
  if (!item || item.company !== company) throw new ApiError(404, 'EQUIPMENT_NOT_FOUND', '找不到可申请的同公司设备');
  if (item.category !== category) throw new ApiError(422, 'INVALID_INPUT', '申请类别须与关联设备一致');
  if (item.status !== 'available') throw new ApiError(409, 'EQUIPMENT_UNAVAILABLE', '这台设备当前不可领取，请选择其他设备或提交新设备申请');
  return { id: item.id, name: item.name, serialNumber: item.serial_number };
}

// Called inside the request store's transaction using that exact connection.
// Device use, request status and both audit trails either all commit or all roll back.
export function collectRequestedEquipment({ db, request, user, at, resolveMember }) {
  const member = resolveMember(request.applicantId);
  if (!member || !(member.companies ?? [member.company]).includes(request.company)) throw new ApiError(409, 'APPLICANT_CHANGED', '申请人的账号或公司已变更，请先核实申请');
  const item = db.prepare('SELECT * FROM equipment WHERE id=?').get(request.equipmentId);
  if (!item || item.company !== request.company) throw new ApiError(409, 'EQUIPMENT_CHANGED', '设备所属公司已变更，请先核实申请');
  if (item.category !== request.category || item.status !== 'available' || item.current_user) throw new ApiError(409, 'EQUIPMENT_UNAVAILABLE', '设备已被领用或状态发生变化，请刷新后处理');
  const updated = db.prepare("UPDATE equipment SET current_user=?,status='in_use',version=version+1,updated_at=?,editor_id=?,editor_name=? WHERE id=? AND version=?")
    .run(member.name, at, user.id, user.name, item.id, item.version);
  if (!updated.changes) throw new ApiError(409, 'VERSION_CONFLICT', '设备已变化，请刷新后处理');
  db.prepare("INSERT INTO equipment_changes(equipment_id,actor_id,actor_name,action,at,changes,company) VALUES(?,?,?,'updated',?,?,?)")
    .run(item.id, user.id, user.name, at, JSON.stringify([
      { field: 'currentUser', oldValue: item.current_user, newValue: member.name },
      { field: 'status', oldValue: item.status, newValue: 'in_use' },
    ]), request.company);
  return true;
}
