import { getSupabaseClient } from "./client";
import { AuthRecord } from "../lib/types/auth.types";

export const AuthRepository = {
  async create(data: {
    user_id: string;
    email: string;
    username: string;
    password_hash: string;
  }): Promise<AuthRecord> {
    const supabase = getSupabaseClient();

    const { data: auth, error } = await supabase
      .from("auth")
      .insert({
        user_id: data.user_id,
        email: data.email,
        username: data.username,
        password_hash: data.password_hash,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create auth record: ${error.message}`);
    }

    return auth as AuthRecord;
  },

  async findByUserId(userId: string): Promise<AuthRecord | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("auth")
      .select()
      .eq("user_id", userId)
      .single();

    if (error) return null;
    return data as AuthRecord;
  },

  async findByEmail(email: string): Promise<AuthRecord | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("auth")
      .select()
      .eq("email", email)
      .single();

    if (error) return null;
    return data as AuthRecord;
  },

  async findByUsername(username: string): Promise<AuthRecord | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("auth")
      .select()
      .eq("username", username)
      .single();

    if (error) return null;
    return data as AuthRecord;
  },

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("auth")
      .update({
        password_hash: passwordHash,
        password_changed_at: new Date().toISOString(),
      })
      .eq("user_id", userId);

    if (error) {
      throw new Error(`Failed to update password: ${error.message}`);
    }
  },

  async setOtp(userId: string, otp: string, expiresAt: Date): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("auth")
      .update({
        otp,
        otp_expires_at: expiresAt.toISOString(),
      })
      .eq("user_id", userId);

    if (error) {
      throw new Error(`Failed to set OTP: ${error.message}`);
    }
  },

  async clearOtp(userId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("auth")
      .update({
        otp: null,
        otp_expires_at: null,
      })
      .eq("user_id", userId);

    if (error) {
      throw new Error(`Failed to clear OTP: ${error.message}`);
    }
  },

  async updateLastLogin(userId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("auth")
      .update({ last_login_at: new Date().toISOString() })
      .eq("user_id", userId);

    if (error) {
      throw new Error(`Failed to update last login: ${error.message}`);
    }
  },

  async setIsValid(userId: string, isValid: boolean): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("auth")
      .update({ is_valid: isValid })
      .eq("user_id", userId);

    if (error) {
      throw new Error(`Failed to update is_valid: ${error.message}`);
    }
  },
};
