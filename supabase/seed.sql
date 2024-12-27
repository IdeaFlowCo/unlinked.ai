-- Companies
INSERT INTO companies (id, name) VALUES
    ('11111111-1111-1111-1111-111111111111', 'Google'),
    ('22222222-2222-2222-2222-222222222222', 'Microsoft'),
    ('33333333-3333-3333-3333-333333333333', 'Apple'),
    ('44444444-4444-4444-4444-444444444444', 'Meta'),
    ('55555555-5555-5555-5555-555555555555', 'Amazon'),
    ('66666666-6666-6666-6666-666666666666', 'Netflix'),
    ('77777777-7777-7777-7777-777777777777', 'Tesla');

-- Institutions
INSERT INTO institutions (id, name) VALUES
    ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Stanford University'),
    ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'MIT'),
    ('cccccccc-cccc-cccc-cccc-cccccccccccc', 'UC Berkeley'),
    ('dddddddd-dddd-dddd-dddd-dddddddddddd', 'Harvard University');

-- Profiles
INSERT INTO profiles (id, first_name, last_name, headline, industry) VALUES
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'Sarah', 'Chen', 'Senior ML Engineer at Google', 'Technology'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', 'Michael', 'Rodriguez', 'Product Manager at Microsoft', 'Technology'),
    ('c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3', 'Emily', 'Patel', 'Software Engineer at Apple', 'Technology'),
    ('d4d4d4d4-4444-4444-4444-d4d4d4d4d4d4', 'James', 'Wilson', 'Data Scientist at Meta', 'Technology'),
    ('e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5', 'Olivia', 'Taylor', 'Frontend Engineer at Netflix', 'Technology'),
    ('f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6', 'Alexander', 'Kim', 'Backend Engineer at Amazon', 'Technology'),
    ('a7a7a7a7-7777-7777-7777-a7a7a7a7a7a7', 'Sophia', 'Martinez', 'AI Researcher at Tesla', 'Technology');

-- Positions
INSERT INTO positions (profile_id, company_id, title, started_on, finished_on) VALUES
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', '11111111-1111-1111-1111-111111111111', 'Senior ML Engineer', '2022-01-01', NULL),
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', '44444444-4444-4444-4444-444444444444', 'ML Engineer', '2019-01-01', '2021-12-31'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', '22222222-2222-2222-2222-222222222222', 'Product Manager', '2021-06-01', NULL),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', '55555555-5555-5555-5555-555555555555', 'Associate PM', '2019-01-01', '2021-05-31'),
    ('c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3', '33333333-3333-3333-3333-333333333333', 'Software Engineer', '2020-01-01', NULL),
    ('d4d4d4d4-4444-4444-4444-d4d4d4d4d4d4', '44444444-4444-4444-4444-444444444444', 'Data Scientist', '2021-01-01', NULL),
    ('e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5', '66666666-6666-6666-6666-666666666666', 'Frontend Engineer', '2022-01-01', NULL),
    ('f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6', '55555555-5555-5555-5555-555555555555', 'Backend Engineer', '2021-01-01', NULL),
    ('a7a7a7a7-7777-7777-7777-a7a7a7a7a7a7', '77777777-7777-7777-7777-777777777777', 'AI Researcher', '2022-01-01', NULL);

-- Education
INSERT INTO education (profile_id, institution_id, degree_name, started_on, finished_on) VALUES
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'MS Computer Science', '2017-09-01', '2019-06-01'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'BS Computer Science', '2015-09-01', '2019-06-01'),
    ('c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'BS Computer Science', '2016-09-01', '2020-06-01'),
    ('d4d4d4d4-4444-4444-4444-d4d4d4d4d4d4', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'PhD Statistics', '2018-09-01', '2021-06-01'),
    ('e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'BS Computer Science', '2018-09-01', '2022-06-01'),
    ('f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'MS Computer Science', '2019-09-01', '2021-06-01'),
    ('a7a7a7a7-7777-7777-7777-a7a7a7a7a7a7', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'PhD Computer Science', '2017-09-01', '2022-06-01');

-- Skills
INSERT INTO skills (profile_id, name) VALUES
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'Machine Learning'),
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'Python'),
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'TensorFlow'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', 'Product Management'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', 'Agile'),
    ('c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3', 'JavaScript'),
    ('c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3', 'React'),
    ('d4d4d4d4-4444-4444-4444-d4d4d4d4d4d4', 'Data Science'),
    ('d4d4d4d4-4444-4444-4444-d4d4d4d4d4d4', 'Python'),
    ('e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5', 'React'),
    ('e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5', 'TypeScript'),
    ('f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6', 'Node.js'),
    ('f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6', 'AWS'),
    ('a7a7a7a7-7777-7777-7777-a7a7a7a7a7a7', 'Deep Learning'),
    ('a7a7a7a7-7777-7777-7777-a7a7a7a7a7a7', 'PyTorch');

-- Connections
INSERT INTO connections (profile_id_a, profile_id_b) VALUES
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'd4d4d4d4-4444-4444-4444-d4d4d4d4d4d4'),
    ('a1a1a1a1-1111-1111-1111-a1a1a1a1a1a1', 'f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', 'c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3'),
    ('b2b2b2b2-2222-2222-2222-b2b2b2b2b2b2', 'e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5'),
    ('c3c3c3c3-3333-3333-3333-c3c3c3c3c3c3', 'f6f6f6f6-6666-6666-6666-f6f6f6f6f6f6'),
    ('d4d4d4d4-4444-4444-4444-d4d4d4d4d4d4', 'e5e5e5e5-5555-5555-5555-e5e5e5e5e5e5');

-- Generate embeddings
DO $$
BEGIN
  UPDATE profiles SET embedding = (
    SELECT array_agg(random())::vector(1536)
    FROM generate_series(1, 1536)
  );
END $$;
