export class RoleManager { getRole(_n: string) { return { superuser: false }; } isMemberOf(..._a: any[]) { return true; } }
