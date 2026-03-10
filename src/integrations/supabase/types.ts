export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_address: string | null
          user_id: string
        }
        Insert: {
          action: string
          created_at?: string
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: string | null
          user_id: string
        }
        Update: {
          action?: string
          created_at?: string
          details?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: string | null
          user_id?: string
        }
        Relationships: []
      }
      automation_settings: {
        Row: {
          company_id: string
          created_at: string
          enabled: boolean
          id: string
          message_template: string
          type: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          enabled?: boolean
          id?: string
          message_template?: string
          type: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          enabled?: boolean
          id?: string
          message_template?: string
          type?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "automation_settings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          address: string | null
          cnpj: string | null
          created_at: string
          description: string | null
          email: string | null
          google_maps_url: string | null
          id: string
          instagram: string | null
          logo_url: string | null
          name: string
          opening_hours: Json | null
          payment_methods: Json | null
          phone: string | null
          razao_social: string | null
          reservation_duration: number
          responsible_email: string | null
          responsible_name: string | null
          responsible_phone: string | null
          slug: string
          status: string
          updated_at: string
          whatsapp: string | null
        }
        Insert: {
          address?: string | null
          cnpj?: string | null
          created_at?: string
          description?: string | null
          email?: string | null
          google_maps_url?: string | null
          id?: string
          instagram?: string | null
          logo_url?: string | null
          name: string
          opening_hours?: Json | null
          payment_methods?: Json | null
          phone?: string | null
          razao_social?: string | null
          reservation_duration?: number
          responsible_email?: string | null
          responsible_name?: string | null
          responsible_phone?: string | null
          slug: string
          status?: string
          updated_at?: string
          whatsapp?: string | null
        }
        Update: {
          address?: string | null
          cnpj?: string | null
          created_at?: string
          description?: string | null
          email?: string | null
          google_maps_url?: string | null
          id?: string
          instagram?: string | null
          logo_url?: string | null
          name?: string
          opening_hours?: Json | null
          payment_methods?: Json | null
          phone?: string | null
          razao_social?: string | null
          reservation_duration?: number
          responsible_email?: string | null
          responsible_name?: string | null
          responsible_phone?: string | null
          slug?: string
          status?: string
          updated_at?: string
          whatsapp?: string | null
        }
        Relationships: []
      }
      company_whatsapp_instances: {
        Row: {
          company_id: string
          created_at: string
          id: string
          instance_name: string
          phone_number: string | null
          status: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          instance_name: string
          phone_number?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          instance_name?: string
          phone_number?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_whatsapp_instances_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          company_id: string | null
          created_at: string
          created_by: string | null
          id: string
          is_read: boolean
          message: string
          read_at: string | null
          title: string
          type: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_read?: boolean
          message: string
          read_at?: string | null
          title: string
          type?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          is_read?: boolean
          message?: string
          read_at?: string | null
          title?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          company_id: string | null
          created_at: string
          email: string | null
          full_name: string
          id: string
          phone: string | null
          updated_at: string
        }
        Insert: {
          company_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id: string
          phone?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string | null
          created_at?: string
          email?: string | null
          full_name?: string
          id?: string
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "profiles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_funnel_logs: {
        Row: {
          company_id: string
          created_at: string
          date: string
          id: string
          step: string
          visitor_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          date?: string
          id?: string
          step: string
          visitor_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          date?: string
          id?: string
          step?: string
          visitor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_funnel_logs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      reservations: {
        Row: {
          company_id: string
          created_at: string
          date: string
          duration_minutes: number
          guest_birthdate: string | null
          guest_email: string | null
          guest_name: string
          guest_phone: string
          id: string
          notes: string | null
          occasion: string | null
          party_size: number
          status: string
          table_id: string | null
          time: string
          updated_at: string
          visitor_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          date: string
          duration_minutes?: number
          guest_birthdate?: string | null
          guest_email?: string | null
          guest_name: string
          guest_phone: string
          id?: string
          notes?: string | null
          occasion?: string | null
          party_size?: number
          status?: string
          table_id?: string | null
          time: string
          updated_at?: string
          visitor_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          date?: string
          duration_minutes?: number
          guest_birthdate?: string | null
          guest_email?: string | null
          guest_name?: string
          guest_phone?: string
          id?: string
          notes?: string | null
          occasion?: string | null
          party_size?: number
          status?: string
          table_id?: string | null
          time?: string
          updated_at?: string
          visitor_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "reservations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "restaurant_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      restaurant_tables: {
        Row: {
          capacity: number
          company_id: string
          created_at: string
          id: string
          number: number
          section: string
          status: string
          updated_at: string
        }
        Insert: {
          capacity?: number
          company_id: string
          created_at?: string
          id?: string
          number: number
          section?: string
          status?: string
          updated_at?: string
        }
        Update: {
          capacity?: number
          company_id?: string
          created_at?: string
          id?: string
          number?: number
          section?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "restaurant_tables_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          id: string
          key: string
          updated_at: string
          updated_by: string | null
          value: string | null
        }
        Insert: {
          id?: string
          key: string
          updated_at?: string
          updated_by?: string | null
          value?: string | null
        }
        Update: {
          id?: string
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: string | null
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          company_id: string | null
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          company_id?: string | null
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          company_id?: string | null
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          called_at: string | null
          company_id: string
          created_at: string
          expired_at: string | null
          guest_name: string
          guest_phone: string
          id: string
          notes: string | null
          party_size: number
          position: number
          seated_at: string | null
          status: string
          tracking_code: string
          updated_at: string
        }
        Insert: {
          called_at?: string | null
          company_id: string
          created_at?: string
          expired_at?: string | null
          guest_name: string
          guest_phone: string
          id?: string
          notes?: string | null
          party_size?: number
          position?: number
          seated_at?: string | null
          status?: string
          tracking_code?: string
          updated_at?: string
        }
        Update: {
          called_at?: string | null
          company_id?: string
          created_at?: string
          expired_at?: string | null
          guest_name?: string
          guest_phone?: string
          id?: string
          notes?: string | null
          party_size?: number
          position?: number
          seated_at?: string | null
          status?: string
          tracking_code?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "waitlist_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      webhook_configs: {
        Row: {
          company_id: string
          created_at: string
          enabled: boolean
          events: Json
          id: string
          secret: string | null
          updated_at: string
          url: string
        }
        Insert: {
          company_id: string
          created_at?: string
          enabled?: boolean
          events?: Json
          id?: string
          secret?: string | null
          updated_at?: string
          url: string
        }
        Update: {
          company_id?: string
          created_at?: string
          enabled?: boolean
          events?: Json
          id?: string
          secret?: string | null
          updated_at?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "webhook_configs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      whatsapp_message_logs: {
        Row: {
          company_id: string
          created_at: string
          error_details: string | null
          id: string
          message: string
          phone: string
          reservation_id: string | null
          status: string
          type: string
        }
        Insert: {
          company_id: string
          created_at?: string
          error_details?: string | null
          id?: string
          message: string
          phone: string
          reservation_id?: string | null
          status?: string
          type?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          error_details?: string | null
          id?: string
          message?: string
          phone?: string
          reservation_id?: string | null
          status?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "whatsapp_message_logs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "whatsapp_message_logs_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      has_role_in_company: {
        Args: {
          _company_id: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "superadmin" | "admin" | "operator"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["superadmin", "admin", "operator"],
    },
  },
} as const
