/** CMS RBAC helpers (separate from PRD). */

export function hasPermission(user, permission) {
  if (!user || !permission) return false;
  const list = user.permissions;
  if (!Array.isArray(list) || !list.length) return false;
  return list.includes(permission);
}

export function hasAnyPermission(user, ...permissions) {
  return permissions.some((permission) => hasPermission(user, permission));
}

export function hasRole(user, roleName) {
  if (!user || !roleName) return false;
  if (Array.isArray(user.roles) && user.roles.includes(roleName)) return true;
  return user.role === roleName;
}

export function isBuiltInAdmin(user) {
  return hasRole(user, "developer") || hasRole(user, "admin");
}

export function isCmsAdmin(user) {
  return isBuiltInAdmin(user) || hasPermission(user, "complaints.manage_all");
}

export function canManageSystem(user) {
  return isBuiltInAdmin(user);
}

export function canAccessMasters(user) {
  return isBuiltInAdmin(user) || hasPermission(user, "masters.read");
}

export function canManageMasters(user) {
  return isBuiltInAdmin(user);
}

export function canCsWork(user) {
  return isCmsAdmin(user) || hasPermission(user, "complaints.cs");
}

export function canQaWork(user) {
  return isCmsAdmin(user) || hasPermission(user, "complaints.qa");
}

export function canDepartmentWork(user) {
  return isCmsAdmin(user) || hasPermission(user, "complaints.department");
}

export function canUpdateRejects(user) {
  return isCmsAdmin(user) || hasPermission(user, "rejects.update");
}

export function requirePermission(...permissions) {
  return function requirePermissionMiddleware(req, res, next) {
    const ok = permissions.some((permission) => hasPermission(req.user, permission));
    if (!ok && !isCmsAdmin(req.user)) {
      return res.status(403).json({ message: "ไม่มีสิทธิ์ดำเนินการ" });
    }
    return next();
  };
}
