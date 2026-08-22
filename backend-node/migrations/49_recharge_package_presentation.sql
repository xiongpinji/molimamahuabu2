ALTER TABLE recharge_packages
  ADD COLUMN badge_text TEXT NOT NULL DEFAULT '';

ALTER TABLE recharge_packages
  ADD COLUMN ad_title TEXT NOT NULL DEFAULT '';

ALTER TABLE recharge_packages
  ADD COLUMN ad_subtitle TEXT NOT NULL DEFAULT '';

ALTER TABLE recharge_packages
  ADD COLUMN button_text TEXT NOT NULL DEFAULT '立即购买';

ALTER TABLE recharge_packages
  ADD COLUMN accent_color TEXT NOT NULL DEFAULT '#ff7139';

ALTER TABLE recharge_packages
  ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0;

ALTER TABLE recharge_packages
  ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0, 1));

CREATE UNIQUE INDEX uq_recharge_packages_featured
  ON recharge_packages(is_featured)
  WHERE is_featured = 1;
