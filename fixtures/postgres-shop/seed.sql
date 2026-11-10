-- Seed data. Values look realistic on purpose so tests can prove none of them
-- survive masking or appear in logs. They are fictional.
INSERT INTO users (id, email, full_name, phone, last_login_ip, date_of_birth, manager_id, created_at, stripe_customer_id, auth0_user_id) VALUES
  (1, 'alice.liddell@wonderland-mail.net', 'Alice Liddell', '+44 20 7946 0958', '198.51.100.23', '1990-05-04', NULL, '2024-01-10T09:00:00Z', 'cus_Alice00000001', 'auth0|alice0001'),
  (2, 'bob.marley.reggae@islandnet.org', 'Bobby Marlowe', '+1 (415) 555-0199', '203.0.113.77', '1985-02-06', 1, '2024-02-11T10:30:00Z', 'cus_Bob000000002', 'auth0|bob0002'),
  (3, 'carol.danvers@starforce-hq.io', 'Carol Danvers', '+49 30 901820', '192.0.2.144', '1979-11-30', NULL, '2024-03-12T11:45:00Z', NULL, NULL);
SELECT setval(pg_get_serial_sequence('users', 'id'), 3);

INSERT INTO addresses (user_id, street, postal_code, city) VALUES
  (1, '7 Rabbit Hole Lane', 'OX1 3BG', 'Oxfordshire'),
  (2, '56 Hope Road', 'KN5', 'Kingstonville'),
  (3, '1 Hala Way', '10115', 'Berlinchen');

INSERT INTO products (sku, title) VALUES ('TEA-01', 'Mad Hatter Tea'), ('MUG-02', 'Teacup');

INSERT INTO orders (id, user_id, total_cents, placed_at) VALUES
  (10, 1, 2500, '2024-04-01T12:00:00Z'),
  (11, 1, 1200, '2024-04-02T12:00:00Z'),
  (12, 2, 999, '2024-04-03T12:00:00Z');
SELECT setval(pg_get_serial_sequence('orders', 'id'), 12);

INSERT INTO order_items (order_id, sku, qty) VALUES
  (10, 'TEA-01', 2), (10, 'MUG-02', 1), (11, 'TEA-01', 1), (12, 'MUG-02', 3);

INSERT INTO invoices (id, user_id, order_id, billing_name, billing_email, amount_cents, issued_on) VALUES
  (100, 1, 10, 'Alice Liddell', 'alice.liddell@wonderland-mail.net', 2500, '2024-04-01'),
  (101, 2, 12, 'Bobby Marlowe', 'bob.marley.reggae@islandnet.org', 999, '2024-04-03');
SELECT setval(pg_get_serial_sequence('invoices', 'id'), 101);

INSERT INTO invoice_lines (invoice_id, description, amount_cents) VALUES
  (100, 'Mad Hatter Tea x2', 2000), (100, 'Teacup', 500), (101, 'Teacup x3', 999);

INSERT INTO login_events (user_email, ip_address, happened_at) VALUES
  ('alice.liddell@wonderland-mail.net', '198.51.100.23', '2024-05-01T08:00:00Z'),
  ('alice.liddell@wonderland-mail.net', '198.51.100.24', '2024-05-02T08:00:00Z'),
  ('carol.danvers@starforce-hq.io', '192.0.2.144', '2024-05-03T08:00:00Z');

INSERT INTO support_tickets (requester_id, body) VALUES
  (1, 'Please call me back on +44 20 7946 0958 about my order'),
  (1, '=HYPERLINK("http://evil.example","click")'),
  (3, 'Where is my refund?');
