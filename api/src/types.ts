export type UserRole = 'member' | 'manager' | 'admin';

export type Bindings = {
  DB: D1Database;
  APP_ENV?: 'local' | 'staging' | 'production';
  ALLOWED_ORIGINS?: string;
  FRONTEND_URL?: string;
  SESSION_SITE_DOMAIN?: string;
  DISCORD_CLIENT_ID?: string;
  DISCORD_CLIENT_SECRET?: string;
  DISCORD_REDIRECT_URI?: string;
  BOOTSTRAP_ADMIN_DISCORD_USER_ID?: string;
};

export type SessionUser = {
  id: number;
  name: string;
  group_id: string;
  role: UserRole;
};

export type AuthContext = {
  sessionId: number;
  sessionToken: string;
  user: SessionUser;
};

export type AppEnv = {
  Bindings: Bindings;
  Variables: {
    auth: AuthContext;
  };
};
