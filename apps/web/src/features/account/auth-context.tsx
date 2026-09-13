"use client";

import { createContext, useContext } from "react";

export type ScoutAccount = {
  userId: string;
  email: string | null;
};

export type AuthState = {
  configured: boolean;
  ready: boolean;
  restoring: boolean;
  hasSession: boolean;
  account: ScoutAccount | null;
  cacheKey: string;
  error: string | null;
  login: (destination?: string) => void;
  logout: () => Promise<void>;
  restore: () => Promise<void>;
};

export const AuthContext = createContext<AuthState>({
  configured: false,
  ready: true,
  restoring: false,
  hasSession: false,
  account: null,
  cacheKey: "anonymous",
  error: null,
  login: () => {},
  logout: async () => {},
  restore: async () => {},
});

export const useScoutAuth = () => useContext(AuthContext);
