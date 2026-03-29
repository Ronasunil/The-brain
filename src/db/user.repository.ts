import { getSupabaseClient } from "./client";
import { UserRecord } from "../lib/types/auth.types";

export const UserRepository = {
  async create(data: {
    email: string;
    name: string;
    role?: string;
    avatar_url?: string;
    phone?: string;
  }): Promise<UserRecord> {
    const supabase = getSupabaseClient();

    const { data: user, error } = await supabase
      .from("users")
      .insert({
        email: data.email,
        name: data.name,
        role: data.role || "user",
        avatar_url: data.avatar_url || null,
        phone: data.phone || null,
      })
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to create user: ${error.message}`);
    }

    return user as UserRecord;
  },

  async findById(id: string): Promise<UserRecord | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("users")
      .select()
      .eq("id", id)
      .single();

    if (error) return null;
    return data as UserRecord;
  },

  async findByEmail(email: string): Promise<UserRecord | null> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from("users")
      .select()
      .eq("email", email)
      .single();

    if (error) return null;
    return data as UserRecord;
  },

  async update(
    id: string,
    data: Partial<
      Pick<UserRecord, "email" | "name" | "role" | "avatar_url" | "phone">
    >,
  ): Promise<UserRecord> {
    const supabase = getSupabaseClient();

    const { data: user, error } = await supabase
      .from("users")
      .update(data)
      .eq("id", id)
      .select()
      .single();

    if (error) {
      throw new Error(`Failed to update user: ${error.message}`);
    }

    return user as UserRecord;
  },

  async delete(id: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase.from("users").delete().eq("id", id);

    if (error) {
      throw new Error(`Failed to delete user: ${error.message}`);
    }
  },
};
