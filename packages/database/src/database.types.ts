export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      account_preferences: {
        Row: {
          cooldown_seconds: number
          email: boolean
          telegram: boolean
          timezone: string
          user_id: string
        }
        Insert: {
          cooldown_seconds?: number
          email?: boolean
          telegram?: boolean
          timezone?: string
          user_id: string
        }
        Update: {
          cooldown_seconds?: number
          email?: boolean
          telegram?: boolean
          timezone?: string
          user_id?: string
        }
        Relationships: []
      }
      candidate_detections: {
        Row: {
          created_at: string
          deployment_id: string
          detection: Json
          event_id: string
          rule_version: string
        }
        Insert: {
          created_at?: string
          deployment_id: string
          detection: Json
          event_id: string
          rule_version: string
        }
        Update: {
          created_at?: string
          deployment_id?: string
          detection?: Json
          event_id?: string
          rule_version?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_detections_deployment_id_event_id_fkey"
            columns: ["deployment_id", "event_id"]
            isOneToOne: false
            referencedRelation: "candidate_events"
            referencedColumns: ["deployment_id", "event_id"]
          },
          {
            foreignKeyName: "candidate_detections_rule_version_fkey"
            columns: ["rule_version"]
            isOneToOne: false
            referencedRelation: "watch_versions"
            referencedColumns: ["id"]
          },
        ]
      }
      candidate_events: {
        Row: {
          created_at: string
          deployment_id: string
          envelope: Json
          event_id: string
          user_id: string
          watch_id: string
        }
        Insert: {
          created_at?: string
          deployment_id: string
          envelope: Json
          event_id: string
          user_id: string
          watch_id: string
        }
        Update: {
          created_at?: string
          deployment_id?: string
          envelope?: Json
          event_id?: string
          user_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "candidate_events_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "pipeline_deployments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "candidate_events_watch_id_fkey"
            columns: ["watch_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_decisions: {
        Row: {
          evidence: Json
          finding_id: string
          legacy_incident_id: string | null
          status: string
          updated_at: string
        }
        Insert: {
          evidence: Json
          finding_id: string
          legacy_incident_id?: string | null
          status: string
          updated_at?: string
        }
        Update: {
          evidence?: Json
          finding_id?: string
          legacy_incident_id?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_decisions_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: true
            referencedRelation: "watch_findings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "finding_decisions_legacy_incident_id_fkey"
            columns: ["legacy_incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
        ]
      }
      finding_events: {
        Row: {
          event_id: string
          finding_id: string
        }
        Insert: {
          event_id: string
          finding_id: string
        }
        Update: {
          event_id?: string
          finding_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_events_finding_id_fkey"
            columns: ["finding_id"]
            isOneToOne: false
            referencedRelation: "watch_findings"
            referencedColumns: ["id"]
          },
        ]
      }
      incident_evidence: {
        Row: {
          event_id: string
          incident_id: string
          payload: Json
          user_id: string
        }
        Insert: {
          event_id: string
          incident_id: string
          payload: Json
          user_id: string
        }
        Update: {
          event_id?: string
          incident_id?: string
          payload?: Json
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incident_evidence_incident_id_user_id_fkey"
            columns: ["incident_id", "user_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      incidents: {
        Row: {
          context: Json | null
          created_at: string
          delivery: string
          detection: Json
          explanation: Json | null
          group_key: string
          id: string
          last_enriched_at: string | null
          read_at: string | null
          status: string
          title: string
          updated_at: string
          user_id: string
          version_id: string
          watch_id: string
        }
        Insert: {
          context?: Json | null
          created_at?: string
          delivery?: string
          detection: Json
          explanation?: Json | null
          group_key: string
          id?: string
          last_enriched_at?: string | null
          read_at?: string | null
          status?: string
          title: string
          updated_at?: string
          user_id: string
          version_id: string
          watch_id: string
        }
        Update: {
          context?: Json | null
          created_at?: string
          delivery?: string
          detection?: Json
          explanation?: Json | null
          group_key?: string
          id?: string
          last_enriched_at?: string | null
          read_at?: string | null
          status?: string
          title?: string
          updated_at?: string
          user_id?: string
          version_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "incidents_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "watch_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "incidents_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      investigation_decisions: {
        Row: {
          attempts: number
          created_at: string
          evidence: Json
          incident_id: string
          next_attempt_at: string | null
          revision: string
          status: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          evidence: Json
          incident_id: string
          next_attempt_at?: string | null
          revision: string
          status: string
        }
        Update: {
          attempts?: number
          created_at?: string
          evidence?: Json
          incident_id?: string
          next_attempt_at?: string | null
          revision?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "investigation_decisions_incident_id_fkey"
            columns: ["incident_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_deliveries: {
        Row: {
          attempts: number
          channel: string
          created_at: string
          destination: string | null
          error_code: string | null
          finding_id: string | null
          id: string
          incident_id: string | null
          message_id: number | null
          provider_event_at: string | null
          provider_id: string | null
          sent_at: string | null
          status: string
          user_id: string
        }
        Insert: {
          attempts?: number
          channel?: string
          created_at?: string
          destination?: string | null
          error_code?: string | null
          finding_id?: string | null
          id?: string
          incident_id?: string | null
          message_id?: number | null
          provider_event_at?: string | null
          provider_id?: string | null
          sent_at?: string | null
          status?: string
          user_id: string
        }
        Update: {
          attempts?: number
          channel?: string
          created_at?: string
          destination?: string | null
          error_code?: string | null
          finding_id?: string | null
          id?: string
          incident_id?: string | null
          message_id?: number | null
          provider_event_at?: string | null
          provider_id?: string | null
          sent_at?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "delivery_finding_owner"
            columns: ["finding_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watch_findings"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "notification_deliveries_incident_id_user_id_fkey"
            columns: ["incident_id", "user_id"]
            isOneToOne: false
            referencedRelation: "incidents"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      pipeline_build_attempts: {
        Row: {
          attempt: number
          completed_at: string | null
          created_at: string
          deployment_id: string | null
          diagnostics: Json
          error_code: string | null
          id: string
          log_path: string | null
          status: string
          workflow_id: string
        }
        Insert: {
          attempt: number
          completed_at?: string | null
          created_at?: string
          deployment_id?: string | null
          diagnostics?: Json
          error_code?: string | null
          id?: string
          log_path?: string | null
          status: string
          workflow_id: string
        }
        Update: {
          attempt?: number
          completed_at?: string | null
          created_at?: string
          deployment_id?: string | null
          diagnostics?: Json
          error_code?: string | null
          id?: string
          log_path?: string | null
          status?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_build_attempts_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "pipeline_deployments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pipeline_build_attempts_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "watch_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_deployments: {
        Row: {
          artifact_hash: string | null
          created_at: string
          error: string | null
          id: string
          last_block: number | null
          last_block_time: string | null
          last_message_at: string | null
          proof: Json
          state: string
          user_id: string
          version_id: string
          watch_id: string
          workflow_id: string | null
        }
        Insert: {
          artifact_hash?: string | null
          created_at?: string
          error?: string | null
          id?: string
          last_block?: number | null
          last_block_time?: string | null
          last_message_at?: string | null
          proof?: Json
          state?: string
          user_id: string
          version_id: string
          watch_id: string
          workflow_id?: string | null
        }
        Update: {
          artifact_hash?: string | null
          created_at?: string
          error?: string | null
          id?: string
          last_block?: number | null
          last_block_time?: string | null
          last_message_at?: string | null
          proof?: Json
          state?: string
          user_id?: string
          version_id?: string
          watch_id?: string
          workflow_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_deployments_version_id_watch_id_fkey"
            columns: ["version_id", "watch_id"]
            isOneToOne: false
            referencedRelation: "watch_versions"
            referencedColumns: ["id", "watch_id"]
          },
          {
            foreignKeyName: "pipeline_deployments_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "pipeline_deployments_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: true
            referencedRelation: "watch_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      transaction_intents: {
        Row: {
          chain_id: number
          created_at: string
          expires_at: string
          id: string
          intent: Json
          prepared_transaction: Json | null
          quote: Json
          state: string
          transaction_hash: string | null
          updated_at: string
          user_id: string
          wallet: string
        }
        Insert: {
          chain_id: number
          created_at?: string
          expires_at: string
          id?: string
          intent: Json
          prepared_transaction?: Json | null
          quote: Json
          state?: string
          transaction_hash?: string | null
          updated_at?: string
          user_id: string
          wallet: string
        }
        Update: {
          chain_id?: number
          created_at?: string
          expires_at?: string
          id?: string
          intent?: Json
          prepared_transaction?: Json | null
          quote?: Json
          state?: string
          transaction_hash?: string | null
          updated_at?: string
          user_id?: string
          wallet?: string
        }
        Relationships: []
      }
      watch_clarifications: {
        Row: {
          allow_custom: boolean
          answer: string | null
          answered_at: string | null
          choices: Json
          created_at: string
          field: string
          id: string
          question: string
          reason: string
          status: string
          user_id: string
          watch_id: string
          workflow_id: string
        }
        Insert: {
          allow_custom?: boolean
          answer?: string | null
          answered_at?: string | null
          choices: Json
          created_at?: string
          field: string
          id?: string
          question: string
          reason: string
          status?: string
          user_id: string
          watch_id: string
          workflow_id: string
        }
        Update: {
          allow_custom?: boolean
          answer?: string | null
          answered_at?: string | null
          choices?: Json
          created_at?: string
          field?: string
          id?: string
          question?: string
          reason?: string
          status?: string
          user_id?: string
          watch_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watch_clarifications_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "watch_clarifications_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "watch_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      watch_findings: {
        Row: {
          actor_set: string[]
          anchor_event_id: string
          created_at: string
          deployment_id: string
          evaluation: Json
          id: string
          primary_subject: string | null
          status: string
          user_id: string
          version_id: string
          watch_id: string
          window_from: string
          window_through: string
        }
        Insert: {
          actor_set: string[]
          anchor_event_id: string
          created_at?: string
          deployment_id: string
          evaluation: Json
          id?: string
          primary_subject?: string | null
          status: string
          user_id: string
          version_id: string
          watch_id: string
          window_from: string
          window_through: string
        }
        Update: {
          actor_set?: string[]
          anchor_event_id?: string
          created_at?: string
          deployment_id?: string
          evaluation?: Json
          id?: string
          primary_subject?: string | null
          status?: string
          user_id?: string
          version_id?: string
          watch_id?: string
          window_from?: string
          window_through?: string
        }
        Relationships: [
          {
            foreignKeyName: "finding_program_owner"
            columns: ["version_id", "watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watch_programs"
            referencedColumns: ["version_id", "watch_id", "user_id"]
          },
          {
            foreignKeyName: "watch_findings_deployment_id_fkey"
            columns: ["deployment_id"]
            isOneToOne: false
            referencedRelation: "pipeline_deployments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "watch_findings_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: false
            referencedRelation: "watch_programs"
            referencedColumns: ["version_id"]
          },
          {
            foreignKeyName: "watch_findings_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      watch_programs: {
        Row: {
          chain_id: number
          created_at: string
          event_type: string
          language_version: number
          program: Json
          program_hash: string | null
          user_id: string
          version_id: string
          watch_id: string
        }
        Insert: {
          chain_id: number
          created_at?: string
          event_type: string
          language_version: number
          program: Json
          program_hash?: string | null
          user_id: string
          version_id: string
          watch_id: string
        }
        Update: {
          chain_id?: number
          created_at?: string
          event_type?: string
          language_version?: number
          program?: Json
          program_hash?: string | null
          user_id?: string
          version_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "program_version_owner"
            columns: ["version_id", "watch_id", "user_id"]
            isOneToOne: true
            referencedRelation: "watch_versions"
            referencedColumns: ["id", "watch_id", "user_id"]
          },
          {
            foreignKeyName: "watch_programs_version_id_fkey"
            columns: ["version_id"]
            isOneToOne: true
            referencedRelation: "watch_versions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "watch_programs_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      watch_versions: {
        Row: {
          created_at: string
          id: string
          prompt: string
          spec: Json
          user_id: string
          version: number
          watch_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          prompt: string
          spec: Json
          user_id: string
          version: number
          watch_id: string
        }
        Update: {
          created_at?: string
          id?: string
          prompt?: string
          spec?: Json
          user_id?: string
          version?: number
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watch_versions_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      watch_workflow_events: {
        Row: {
          created_at: string
          id: string
          metadata: Json
          sequence: number
          stage: string
          status: string
          summary: string | null
          title: string
          type: string
          user_id: string
          watch_id: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          metadata?: Json
          sequence: number
          stage: string
          status: string
          summary?: string | null
          title: string
          type: string
          user_id: string
          watch_id: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          id?: string
          metadata?: Json
          sequence?: number
          stage?: string
          status?: string
          summary?: string | null
          title?: string
          type?: string
          user_id?: string
          watch_id?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watch_workflow_events_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
          {
            foreignKeyName: "watch_workflow_events_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "watch_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      watch_workflow_outputs: {
        Row: {
          created_at: string
          kind: string
          payload: Json
          schema_version: number
          updated_at: string
          workflow_id: string
        }
        Insert: {
          created_at?: string
          kind: string
          payload: Json
          schema_version?: number
          updated_at?: string
          workflow_id: string
        }
        Update: {
          created_at?: string
          kind?: string
          payload?: Json
          schema_version?: number
          updated_at?: string
          workflow_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watch_workflow_outputs_workflow_id_fkey"
            columns: ["workflow_id"]
            isOneToOne: false
            referencedRelation: "watch_workflows"
            referencedColumns: ["id"]
          },
        ]
      }
      watch_workflows: {
        Row: {
          created_at: string
          error_category: string | null
          error_code: string | null
          error_message: string | null
          id: string
          original_prompt: string
          recoverable: boolean
          run_number: number
          state: string
          updated_at: string
          user_id: string
          watch_id: string
        }
        Insert: {
          created_at?: string
          error_category?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          original_prompt: string
          recoverable?: boolean
          run_number?: number
          state?: string
          updated_at?: string
          user_id: string
          watch_id: string
        }
        Update: {
          created_at?: string
          error_category?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          original_prompt?: string
          recoverable?: boolean
          run_number?: number
          state?: string
          updated_at?: string
          user_id?: string
          watch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watch_workflows_watch_id_user_id_fkey"
            columns: ["watch_id", "user_id"]
            isOneToOne: false
            referencedRelation: "watches"
            referencedColumns: ["id", "user_id"]
          },
        ]
      }
      watches: {
        Row: {
          active_version_id: string | null
          created_at: string
          desired_state: string
          destination_overrides: Json | null
          error: string | null
          id: string
          last_block: number | null
          last_block_time: string | null
          last_event_at: string | null
          muted_until: string | null
          name: string
          pending_version_id: string | null
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          active_version_id?: string | null
          created_at?: string
          desired_state?: string
          destination_overrides?: Json | null
          error?: string | null
          id?: string
          last_block?: number | null
          last_block_time?: string | null
          last_event_at?: string | null
          muted_until?: string | null
          name: string
          pending_version_id?: string | null
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          active_version_id?: string | null
          created_at?: string
          desired_state?: string
          destination_overrides?: Json | null
          error?: string | null
          id?: string
          last_block?: number | null
          last_block_time?: string | null
          last_event_at?: string | null
          muted_until?: string | null
          name?: string
          pending_version_id?: string | null
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "watch_active_version"
            columns: ["active_version_id", "id"]
            isOneToOne: false
            referencedRelation: "watch_versions"
            referencedColumns: ["id", "watch_id"]
          },
          {
            foreignKeyName: "watch_pending_version"
            columns: ["pending_version_id", "id"]
            isOneToOne: false
            referencedRelation: "watch_versions"
            referencedColumns: ["id", "watch_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      scout_account_rpc: {
        Args: {
          args?: Json
          operation: string
          privy_session: string
          privy_subject: string
        }
        Returns: Json
      }
      scout_answer_clarification: {
        Args: {
          answer_value: string
          target_clarification_id: string
          target_watch_id: string
        }
        Returns: undefined
      }
      scout_authenticate: {
        Args: {
          account_email?: string
          privy_session: string
          privy_subject: string
          provision?: boolean
          token_expires: string
        }
        Returns: Json
      }
      scout_create_watch: { Args: { original_prompt: string }; Returns: string }
      scout_delivery_history: { Args: { incident_id: string }; Returns: Json }
      scout_duplicate_watch: {
        Args: { source_watch_id: string }
        Returns: string
      }
      scout_email_action: { Args: { action: string }; Returns: undefined }
      scout_email_begin: {
        Args: {
          destination: string
          mail_payload: Json
          owner_id: string
          token_hash: string
          use_account?: boolean
        }
        Returns: undefined
      }
      scout_email_begin_for_account: {
        Args: {
          destination: string
          mail_payload: Json
          token_hash: string
          use_account?: boolean
        }
        Returns: undefined
      }
      scout_email_disable: {
        Args: { connection_id: string }
        Returns: undefined
      }
      scout_email_event: {
        Args: {
          event_id: string
          event_type: string
          occurred_at: string
          provider: string
        }
        Returns: undefined
      }
      scout_email_verify: { Args: { token_hash: string }; Returns: undefined }
      scout_incident: { Args: { incident_id: string }; Returns: Json }
      scout_incident_action: {
        Args: { action: string; incident_id: string }
        Returns: undefined
      }
      scout_logout: {
        Args: { privy_session: string; privy_subject: string }
        Returns: undefined
      }
      scout_pair_telegram: { Args: { token_hash: string }; Returns: undefined }
      scout_preferences: { Args: { preferences: Json }; Returns: undefined }
      scout_quote_save: {
        Args: {
          expected_owner: string
          intent_data: Json
          quote_data: Json
          quote_expires: string
          quote_id: string
          wallet_address: string
        }
        Returns: undefined
      }
      scout_rate_limit: {
        Args: { bucket: string; maximum?: number; period_seconds?: number }
        Returns: boolean
      }
      scout_retry_workflow: {
        Args: { target_watch_id: string }
        Returns: undefined
      }
      scout_save_watch: {
        Args: {
          existing_id?: string
          original_prompt: string
          watch_spec: Json
        }
        Returns: string
      }
      scout_save_watch_v2: {
        Args: {
          existing_id?: string
          original_prompt: string
          save_draft?: boolean
          watch_spec: Json
        }
        Returns: string
      }
      scout_snapshot: { Args: never; Returns: Json }
      scout_telegram_action: {
        Args: { action: string; mute_minutes?: number }
        Returns: undefined
      }
      scout_telegram_test_status: { Args: never; Returns: Json }
      scout_telegram_webhook: {
        Args: {
          callback_watch_id?: string
          chat_id?: string
          display_label?: string
          pairing_hash?: string
          telegram_user_id?: string
          update_id: number
        }
        Returns: string
      }
      scout_watch_action: {
        Args: { action: string; mute_minutes?: number; watch_id: string }
        Returns: undefined
      }
      scout_watch_destinations: {
        Args: { channels: Json; watch_id: string }
        Returns: undefined
      }
      scout_watch_detail: { Args: { watch_id: string }; Returns: Json }
      scout_watch_history: {
        Args: {
          page_offset?: number
          search_text?: string
          status_filter?: string
          watch_id: string
        }
        Returns: Json
      }
      scout_watch_workflow: {
        Args: { after_sequence?: number; target_watch_id: string }
        Returns: Json
      }
      scout_watches_page: {
        Args: {
          page_offset?: number
          search_text?: string
          sort_order?: string
          status_filter?: string
        }
        Returns: Json
      }
      scout_workflow_account_rpc: {
        Args: {
          args?: Json
          operation: string
          privy_session: string
          privy_subject: string
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
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
    Enums: {},
  },
} as const
