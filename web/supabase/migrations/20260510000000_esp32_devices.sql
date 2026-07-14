-- ESP32 设备配对与管理表
-- 设备注册表
CREATE TABLE public.esp32_devices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  mac_address text NOT NULL,
  device_name text DEFAULT 'ESP32',
  access_token text NOT NULL,
  firmware_version text,
  last_sync_at timestamptz,
  last_seen_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

-- 配对状态表（临时存储待配对请求，MAC 地址作为主键）
CREATE TABLE public.esp32_pairing_pending (
  mac_address text PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE NOT NULL,
  created_at timestamptz DEFAULT now()
);

-- 唯一约束：同一用户不能重复配对同一 MAC
CREATE UNIQUE INDEX esp32_devices_user_mac_idx ON public.esp32_devices (user_id, mac_address);

-- RLS 策略
ALTER TABLE public.esp32_devices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage own devices" ON public.esp32_devices
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

ALTER TABLE public.esp32_pairing_pending ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can manage pending pairs" ON public.esp32_pairing_pending
  FOR ALL USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
