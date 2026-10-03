/** Role names (API) -> how people read them. Scope rules come from GET /roles. */
export const ROLE_INFO: Record<string, { label: string; hint: string }> = {
  TENANT_ADMIN: { label: "Admin do cliente", hint: "Tudo no cliente: projetos, membros e VMs." },
  PROJECT_ADMIN: { label: "Admin do projeto", hint: "Membros e VMs de um projeto." },
  USER: { label: "Usuário", hint: "Cria, opera e exclui VMs do projeto." },
  OPERATOR: { label: "Operador", hint: "Liga, desliga e reinicia; não cria nem exclui." },
  READ_ONLY: { label: "Somente leitura", hint: "Só visualiza." },
  SUPER_ADMIN: { label: "Super admin", hint: "Plataforma inteira." },
  PLATFORM_ADMIN: { label: "Admin da plataforma", hint: "Operação da plataforma." },
};

export const roleLabel = (name: string) => ROLE_INFO[name]?.label ?? name;
