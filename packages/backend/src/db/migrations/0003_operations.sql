-- AirDesk migration 0003 — ticket-office operations: bookings, pricing,
-- tickets, payments, refunds, expenses, schedule changes, notifications.
-- Additive only. The Phase 0 financial model (fin_document / journal) is
-- unchanged: all money still flows through immutable documents, and every
-- balance/profit figure is still derived from the journal.

-- 1. Pre-issue pricing -------------------------------------------------------
-- A booking is priced BEFORE it is ticketed. These rows are the working quote
-- (editable while DRAFT/RESERVED). Issuing turns them into immutable financial
-- documents (customer invoice + supplier bill); after issue the documents are
-- the only source of truth and these rows are read-only history.
CREATE TABLE booking_price_item (
  id                     TEXT PRIMARY KEY,
  booking_id             TEXT NOT NULL REFERENCES booking(id),
  seq                    INTEGER NOT NULL CHECK (seq >= 1),
  passenger_id           TEXT NOT NULL REFERENCES booking_passenger(id),
  supplier_id            TEXT REFERENCES supplier(id),
  validating_airline_id  TEXT REFERENCES airline(id),
  ticket_number          TEXT,
  -- Sale side, in booking.sale_currency_code (minor units, all >= 0).
  fare_minor             INTEGER NOT NULL DEFAULT 0 CHECK (fare_minor >= 0),
  taxes_minor            INTEGER NOT NULL DEFAULT 0 CHECK (taxes_minor >= 0),
  service_fee_minor      INTEGER NOT NULL DEFAULT 0 CHECK (service_fee_minor >= 0),
  discount_minor         INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  -- Purchase side, in the supplier's billing currency.
  cost_currency_code     TEXT REFERENCES currency(code),
  cost_minor             INTEGER CHECK (cost_minor IS NULL OR cost_minor >= 0),
  supplier_reference     TEXT,
  notes                  TEXT,
  ticket_id              TEXT REFERENCES ticket(id),
  created_at             TEXT NOT NULL,
  created_by             TEXT NOT NULL REFERENCES app_user(id),
  updated_at             TEXT NOT NULL,
  updated_by             TEXT REFERENCES app_user(id),
  row_version            INTEGER NOT NULL DEFAULT 1,
  UNIQUE (booking_id, seq),
  CHECK (discount_minor <= fare_minor + taxes_minor + service_fee_minor)
) STRICT;
CREATE INDEX ix_price_item_booking ON booking_price_item(booking_id);
CREATE UNIQUE INDEX ux_price_item_ticket ON booking_price_item(ticket_id) WHERE ticket_id IS NOT NULL;

-- 2. Booking / passenger / segment / ticket extensions -----------------------
ALTER TABLE booking ADD COLUMN airline_id TEXT REFERENCES airline(id);
ALTER TABLE booking ADD COLUMN sale_exchange_rate TEXT;

ALTER TABLE booking_passenger ADD COLUMN id_document_type TEXT
  CHECK (id_document_type IS NULL OR id_document_type IN ('PASSPORT','NATIONAL_ID','OTHER'));
ALTER TABLE booking_passenger ADD COLUMN id_document_no TEXT;
ALTER TABLE booking_passenger ADD COLUMN frequent_flyer_no TEXT;
ALTER TABLE booking_passenger ADD COLUMN notes TEXT;
ALTER TABLE booking_passenger ADD COLUMN created_at TEXT;
ALTER TABLE booking_passenger ADD COLUMN updated_at TEXT;
CREATE INDEX ix_passenger_booking ON booking_passenger(booking_id);

ALTER TABLE flight_segment ADD COLUMN baggage TEXT;
ALTER TABLE flight_segment ADD COLUMN seat TEXT;
ALTER TABLE flight_segment ADD COLUMN notes TEXT;
CREATE INDEX ix_segment_booking ON flight_segment(booking_id);
CREATE INDEX ix_segment_departure_status ON flight_segment(status, departure_date);

ALTER TABLE ticket ADD COLUMN notes TEXT;
CREATE INDEX ix_ticket_passenger ON ticket(passenger_id);

CREATE INDEX ix_booking_date ON booking(booking_date);
CREATE INDEX ix_booking_agent ON booking(sales_agent_id, booking_date);
CREATE INDEX ix_booking_supplier ON booking(default_supplier_id);
CREATE INDEX ix_status_history_changed_by ON booking_status_history(changed_by, changed_at);

-- 3. Cancellation / refund workflow -----------------------------------------
ALTER TABLE cancellation_request ADD COLUMN supplier_updated_at TEXT;
ALTER TABLE cancellation_request ADD COLUMN customer_updated_at TEXT;
CREATE INDEX ix_cancellation_booking ON cancellation_request(booking_id);
CREATE INDEX ix_cancellation_status ON cancellation_request(overall_status, requested_at);
CREATE INDEX ix_cancellation_item_request ON cancellation_item(cancellation_request_id);

-- 4. Financial documents: external references (supplier invoice number,
--    bank reference) and fast per-user activity queries. Adding a nullable
--    column does not touch existing rows, so immutability triggers still hold.
ALTER TABLE fin_document ADD COLUMN external_reference TEXT;
CREATE INDEX ix_doc_created_by ON fin_document(created_by, doc_date);
CREATE INDEX ix_doc_cancellation ON fin_document(cancellation_request_id) WHERE cancellation_request_id IS NOT NULL;
CREATE INDEX ix_jl_expense ON journal_line(expense_category_id) WHERE expense_category_id IS NOT NULL;
CREATE INDEX ix_jl_ticket ON journal_line(ticket_id) WHERE ticket_id IS NOT NULL;

-- 5. Schedule changes & notifications ---------------------------------------
CREATE INDEX ix_schedule_change_booking ON schedule_change(booking_id, changed_at);
CREATE INDEX ix_schedule_change_segment ON schedule_change(segment_id, changed_at);
CREATE INDEX ix_notification_customer ON notification(customer_id, created_at);
ALTER TABLE notification ADD COLUMN note TEXT;

-- 6. Master data: airports, money accounts, expense categories ---------------
ALTER TABLE airport ADD COLUMN created_at TEXT;
ALTER TABLE airport ADD COLUMN updated_at TEXT;
ALTER TABLE airport ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
CREATE INDEX ix_airport_active_name ON airport(is_active, name_en);

ALTER TABLE money_account ADD COLUMN notes TEXT;
ALTER TABLE money_account ADD COLUMN updated_at TEXT;

ALTER TABLE expense_category ADD COLUMN is_system INTEGER NOT NULL DEFAULT 0 CHECK (is_system IN (0,1));
ALTER TABLE expense_category ADD COLUMN created_at TEXT;
ALTER TABLE expense_category ADD COLUMN updated_at TEXT;
ALTER TABLE expense_category ADD COLUMN row_version INTEGER NOT NULL DEFAULT 1;
UPDATE expense_category SET is_system = 1
  WHERE code IN ('RENT','SALARIES','INTERNET','UTILITIES','BANK_CHARGES','OFFICE','TRANSPORT','OTHER');

-- 7. History is never deleted -------------------------------------------------
CREATE TRIGGER trg_ticket_no_delete BEFORE DELETE ON ticket
BEGIN SELECT RAISE(ABORT, 'Tickets are never deleted'); END;
CREATE TRIGGER trg_airport_no_delete BEFORE DELETE ON airport
BEGIN SELECT RAISE(ABORT, 'Airports are never deleted; deactivate instead'); END;
CREATE TRIGGER trg_expense_category_no_delete BEFORE DELETE ON expense_category
BEGIN SELECT RAISE(ABORT, 'Expense categories are never deleted; archive instead'); END;
CREATE TRIGGER trg_cancellation_no_delete BEFORE DELETE ON cancellation_request
BEGIN SELECT RAISE(ABORT, 'Cancellation requests are never deleted'); END;
CREATE TRIGGER trg_schedule_change_no_delete BEFORE DELETE ON schedule_change
BEGIN SELECT RAISE(ABORT, 'Schedule changes are never deleted'); END;
CREATE TRIGGER trg_notification_no_delete BEFORE DELETE ON notification
BEGIN SELECT RAISE(ABORT, 'Notifications are never deleted'); END;
-- Passengers, segments and price items may be removed only while the booking
-- is still a draft or reservation (nothing financial references them yet).
CREATE TRIGGER trg_passenger_delete_draft_only BEFORE DELETE ON booking_passenger
WHEN (SELECT status FROM booking WHERE id = OLD.booking_id) NOT IN ('DRAFT','RESERVED')
BEGIN SELECT RAISE(ABORT, 'Passengers of an issued booking are never deleted'); END;
CREATE TRIGGER trg_segment_delete_draft_only BEFORE DELETE ON flight_segment
WHEN (SELECT status FROM booking WHERE id = OLD.booking_id) NOT IN ('DRAFT','RESERVED')
BEGIN SELECT RAISE(ABORT, 'Segments of an issued booking are never deleted'); END;
CREATE TRIGGER trg_price_item_delete_draft_only BEFORE DELETE ON booking_price_item
WHEN (SELECT status FROM booking WHERE id = OLD.booking_id) NOT IN ('DRAFT','RESERVED')
BEGIN SELECT RAISE(ABORT, 'Pricing of an issued booking is never deleted'); END;
-- Issued pricing is history: only notes may change afterwards.
CREATE TRIGGER trg_price_item_frozen_after_issue BEFORE UPDATE OF fare_minor, taxes_minor, service_fee_minor, discount_minor,
  cost_minor, cost_currency_code, supplier_id, passenger_id ON booking_price_item
WHEN OLD.ticket_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'Issued pricing is frozen; use an adjustment instead'); END;

-- 8. Reference data: a starter set of airports (editable, deactivatable). ----
INSERT OR IGNORE INTO airport (iata_code, icao_code, name_en, name_ar, city_en, city_ar, country_code, timezone) VALUES
('CAI','HECA','Cairo International','مطار القاهرة الدولي','Cairo','القاهرة','EG','Africa/Cairo'),
('SPX','HESX','Sphinx International','مطار سفنكس الدولي','Giza','الجيزة','EG','Africa/Cairo'),
('HBE','HEBA','Borg El Arab','مطار برج العرب','Alexandria','الإسكندرية','EG','Africa/Cairo'),
('HRG','HEGN','Hurghada International','مطار الغردقة الدولي','Hurghada','الغردقة','EG','Africa/Cairo'),
('SSH','HESH','Sharm El Sheikh International','مطار شرم الشيخ الدولي','Sharm El Sheikh','شرم الشيخ','EG','Africa/Cairo'),
('LXR','HELX','Luxor International','مطار الأقصر الدولي','Luxor','الأقصر','EG','Africa/Cairo'),
('ASW','HESN','Aswan International','مطار أسوان الدولي','Aswan','أسوان','EG','Africa/Cairo'),
('ATZ','HEAT','Assiut','مطار أسيوط','Assiut','أسيوط','EG','Africa/Cairo'),
('SEW','HESW','Siwa','مطار سيوة','Siwa','سيوة','EG','Africa/Cairo'),
('RMF','HEMA','Marsa Alam International','مطار مرسى علم الدولي','Marsa Alam','مرسى علم','EG','Africa/Cairo'),
('JED','OEJN','King Abdulaziz International','مطار الملك عبدالعزيز الدولي','Jeddah','جدة','SA','Asia/Riyadh'),
('RUH','OERK','King Khalid International','مطار الملك خالد الدولي','Riyadh','الرياض','SA','Asia/Riyadh'),
('DMM','OEDF','King Fahd International','مطار الملك فهد الدولي','Dammam','الدمام','SA','Asia/Riyadh'),
('MED','OEMA','Prince Mohammad bin Abdulaziz','مطار الأمير محمد بن عبدالعزيز','Madinah','المدينة المنورة','SA','Asia/Riyadh'),
('TIF','OETF','Taif International','مطار الطائف الدولي','Taif','الطائف','SA','Asia/Riyadh'),
('AHB','OEAB','Abha International','مطار أبها الدولي','Abha','أبها','SA','Asia/Riyadh'),
('TUU','OETB','Tabuk Regional','مطار تبوك','Tabuk','تبوك','SA','Asia/Riyadh'),
('ELQ','OEGS','Prince Naif bin Abdulaziz','مطار الأمير نايف (القصيم)','Qassim','القصيم','SA','Asia/Riyadh'),
('GIZ','OEGN','King Abdullah bin Abdulaziz','مطار جازان','Jazan','جازان','SA','Asia/Riyadh'),
('YNB','OEYN','Prince Abdulmohsin bin Abdulaziz','مطار ينبع','Yanbu','ينبع','SA','Asia/Riyadh'),
('DXB','OMDB','Dubai International','مطار دبي الدولي','Dubai','دبي','AE','Asia/Dubai'),
('DWC','OMDW','Al Maktoum International','مطار آل مكتوم الدولي','Dubai','دبي','AE','Asia/Dubai'),
('AUH','OMAA','Zayed International','مطار زايد الدولي','Abu Dhabi','أبوظبي','AE','Asia/Dubai'),
('SHJ','OMSJ','Sharjah International','مطار الشارقة الدولي','Sharjah','الشارقة','AE','Asia/Dubai'),
('KWI','OKKK','Kuwait International','مطار الكويت الدولي','Kuwait City','الكويت','KW','Asia/Kuwait'),
('DOH','OTHH','Hamad International','مطار حمد الدولي','Doha','الدوحة','QA','Asia/Qatar'),
('BAH','OBBI','Bahrain International','مطار البحرين الدولي','Manama','المنامة','BH','Asia/Bahrain'),
('MCT','OOMS','Muscat International','مطار مسقط الدولي','Muscat','مسقط','OM','Asia/Muscat'),
('AMM','OJAI','Queen Alia International','مطار الملكة علياء الدولي','Amman','عمّان','JO','Asia/Amman'),
('BEY','OLBA','Beirut–Rafic Hariri International','مطار رفيق الحريري الدولي','Beirut','بيروت','LB','Asia/Beirut'),
('BGW','ORBI','Baghdad International','مطار بغداد الدولي','Baghdad','بغداد','IQ','Asia/Baghdad'),
('EBL','ORER','Erbil International','مطار أربيل الدولي','Erbil','أربيل','IQ','Asia/Baghdad'),
('KRT','HSSK','Khartoum International','مطار الخرطوم الدولي','Khartoum','الخرطوم','SD','Africa/Khartoum'),
('PZU','HSPN','Port Sudan New International','مطار بورتسودان','Port Sudan','بورتسودان','SD','Africa/Khartoum'),
('TIP','HLLT','Tripoli International','مطار طرابلس الدولي','Tripoli','طرابلس','LY','Africa/Tripoli'),
('MJI','HLLM','Mitiga International','مطار معيتيقة الدولي','Tripoli','طرابلس','LY','Africa/Tripoli'),
('BEN','HLLB','Benina International','مطار بنينا الدولي','Benghazi','بنغازي','LY','Africa/Tripoli'),
('TUN','DTTA','Tunis–Carthage International','مطار تونس قرطاج الدولي','Tunis','تونس','TN','Africa/Tunis'),
('ALG','DAAG','Houari Boumediene','مطار هواري بومدين','Algiers','الجزائر','DZ','Africa/Algiers'),
('CMN','GMMN','Mohammed V International','مطار محمد الخامس الدولي','Casablanca','الدار البيضاء','MA','Africa/Casablanca'),
('RAK','GMMX','Marrakesh Menara','مطار مراكش المنارة','Marrakesh','مراكش','MA','Africa/Casablanca'),
('IST','LTFM','Istanbul Airport','مطار إسطنبول','Istanbul','إسطنبول','TR','Europe/Istanbul'),
('SAW','LTFJ','Sabiha Gökçen International','مطار صبيحة كوكجن','Istanbul','إسطنبول','TR','Europe/Istanbul'),
('AYT','LTAI','Antalya','مطار أنطاليا','Antalya','أنطاليا','TR','Europe/Istanbul'),
('LHR','EGLL','London Heathrow','مطار هيثرو','London','لندن','GB','Europe/London'),
('LGW','EGKK','London Gatwick','مطار جاتويك','London','لندن','GB','Europe/London'),
('CDG','LFPG','Paris Charles de Gaulle','مطار شارل ديغول','Paris','باريس','FR','Europe/Paris'),
('FRA','EDDF','Frankfurt','مطار فرانكفورت','Frankfurt','فرانكفورت','DE','Europe/Berlin'),
('MUC','EDDM','Munich','مطار ميونخ','Munich','ميونخ','DE','Europe/Berlin'),
('AMS','EHAM','Amsterdam Schiphol','مطار سخيبول','Amsterdam','أمستردام','NL','Europe/Amsterdam'),
('FCO','LIRF','Rome Fiumicino','مطار فيوميتشينو','Rome','روما','IT','Europe/Rome'),
('MXP','LIMC','Milan Malpensa','مطار مالبينسا','Milan','ميلانو','IT','Europe/Rome'),
('MAD','LEMD','Madrid–Barajas','مطار باراخاس','Madrid','مدريد','ES','Europe/Madrid'),
('ATH','LGAV','Athens International','مطار أثينا الدولي','Athens','أثينا','GR','Europe/Athens'),
('VIE','LOWW','Vienna International','مطار فيينا الدولي','Vienna','فيينا','AT','Europe/Vienna'),
('ZRH','LSZH','Zurich','مطار زيورخ','Zurich','زيورخ','CH','Europe/Zurich'),
('GVA','LSGG','Geneva','مطار جنيف','Geneva','جنيف','CH','Europe/Zurich'),
('JFK','KJFK','John F. Kennedy International','مطار جون كينيدي الدولي','New York','نيويورك','US','America/New_York'),
('IAD','KIAD','Washington Dulles International','مطار دالاس الدولي','Washington','واشنطن','US','America/New_York'),
('ORD','KORD','Chicago O''Hare International','مطار أوهير الدولي','Chicago','شيكاغو','US','America/Chicago'),
('LAX','KLAX','Los Angeles International','مطار لوس أنجلوس الدولي','Los Angeles','لوس أنجلوس','US','America/Los_Angeles'),
('YYZ','CYYZ','Toronto Pearson International','مطار تورونتو بيرسون','Toronto','تورونتو','CA','America/Toronto'),
('ADD','HAAB','Addis Ababa Bole International','مطار أديس أبابا بولي','Addis Ababa','أديس أبابا','ET','Africa/Addis_Ababa'),
('NBO','HKJK','Jomo Kenyatta International','مطار جومو كينياتا','Nairobi','نيروبي','KE','Africa/Nairobi'),
('JNB','FAOR','O. R. Tambo International','مطار أو. آر. تامبو','Johannesburg','جوهانسبرغ','ZA','Africa/Johannesburg'),
('LOS','DNMM','Murtala Muhammed International','مطار مرتالا محمد','Lagos','لاغوس','NG','Africa/Lagos'),
('KHI','OPKC','Jinnah International','مطار جناح الدولي','Karachi','كراتشي','PK','Asia/Karachi'),
('LHE','OPLA','Allama Iqbal International','مطار العلامة إقبال','Lahore','لاهور','PK','Asia/Karachi'),
('DEL','VIDP','Indira Gandhi International','مطار إنديرا غاندي','Delhi','دلهي','IN','Asia/Kolkata'),
('BOM','VABB','Chhatrapati Shivaji Maharaj International','مطار مومباي','Mumbai','مومباي','IN','Asia/Kolkata'),
('DAC','VGHS','Hazrat Shahjalal International','مطار شاه جلال','Dhaka','دكا','BD','Asia/Dhaka'),
('KUL','WMKK','Kuala Lumpur International','مطار كوالالمبور الدولي','Kuala Lumpur','كوالالمبور','MY','Asia/Kuala_Lumpur'),
('CGK','WIII','Soekarno–Hatta International','مطار سوكارنو هاتا','Jakarta','جاكرتا','ID','Asia/Jakarta'),
('BKK','VTBS','Suvarnabhumi','مطار سوفارنابومي','Bangkok','بانكوك','TH','Asia/Bangkok'),
('SIN','WSSS','Singapore Changi','مطار شانغي','Singapore','سنغافورة','SG','Asia/Singapore'),
('PEK','ZBAA','Beijing Capital International','مطار بكين الدولي','Beijing','بكين','CN','Asia/Shanghai'),
('CAN','ZGGG','Guangzhou Baiyun International','مطار قوانغتشو','Guangzhou','قوانغتشو','CN','Asia/Shanghai'),
('HKG','VHHH','Hong Kong International','مطار هونغ كونغ الدولي','Hong Kong','هونغ كونغ','HK','Asia/Hong_Kong'),
('NRT','RJAA','Narita International','مطار ناريتا الدولي','Tokyo','طوكيو','JP','Asia/Tokyo'),
('SYD','YSSY','Sydney Kingsford Smith','مطار سيدني','Sydney','سيدني','AU','Australia/Sydney');
