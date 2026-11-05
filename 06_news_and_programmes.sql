
-- 1. Create the News & Programmes table
CREATE TABLE IF NOT EXISTS public.news_posts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    post_type text NOT NULL
        CHECK (post_type IN ('news', 'programme')),

    headline text NOT NULL
        CHECK (char_length(btrim(headline)) BETWEEN 1 AND 160),

    summary text NOT NULL
        CHECK (char_length(btrim(summary)) BETWEEN 1 AND 320),

    body text NOT NULL
        CHECK (char_length(btrim(body)) BETWEEN 1 AND 10000),

    flyer_path text,

    event_date date,
    event_time time,
    venue text,

    is_published boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT news_posts_event_details_check CHECK (
        (
            post_type = 'news'
            AND event_date IS NULL
            AND event_time IS NULL
            AND venue IS NULL
        )
        OR
        (
            post_type = 'programme'
            AND event_date IS NOT NULL
            AND event_time IS NOT NULL
            AND venue IS NOT NULL
            AND char_length(btrim(venue)) BETWEEN 1 AND 160
        )
    )
);

-- Recreate the event constraint so this migration also repairs an older
-- version where a NULL venue could pass the CHECK expression.
ALTER TABLE public.news_posts
    DROP CONSTRAINT IF EXISTS news_posts_event_details_check;
ALTER TABLE public.news_posts
    ADD CONSTRAINT news_posts_event_details_check CHECK (
        (post_type = 'news' AND event_date IS NULL AND event_time IS NULL AND venue IS NULL)
        OR
        (post_type = 'programme' AND event_date IS NOT NULL AND event_time IS NOT NULL
         AND venue IS NOT NULL AND char_length(btrim(venue)) BETWEEN 1 AND 160)
    );

-- 2. Enable row-level security
ALTER TABLE public.news_posts ENABLE ROW LEVEL SECURITY;

-- 3. Allow visitors to read published news
GRANT SELECT ON public.news_posts TO anon, authenticated;

DROP POLICY IF EXISTS news_posts_public_read
ON public.news_posts;

CREATE POLICY news_posts_public_read
ON public.news_posts
FOR SELECT TO anon
USING (is_published = true);

-- Signed-in users can read published posts.
-- Administrators can also read unpublished posts.
DROP POLICY IF EXISTS news_posts_authenticated_read
ON public.news_posts;

CREATE POLICY news_posts_authenticated_read
ON public.news_posts
FOR SELECT TO authenticated
USING (
    is_published = true
    OR private.is_admin()
);

-- 4. Only administrators can create, edit or delete posts
GRANT INSERT, UPDATE, DELETE
ON public.news_posts TO authenticated;

DROP POLICY IF EXISTS news_posts_admin_insert
ON public.news_posts;

CREATE POLICY news_posts_admin_insert
ON public.news_posts
FOR INSERT TO authenticated
WITH CHECK (private.is_admin());

DROP POLICY IF EXISTS news_posts_admin_update
ON public.news_posts;

CREATE POLICY news_posts_admin_update
ON public.news_posts
FOR UPDATE TO authenticated
USING (private.is_admin())
WITH CHECK (private.is_admin());

DROP POLICY IF EXISTS news_posts_admin_delete
ON public.news_posts;

CREATE POLICY news_posts_admin_delete
ON public.news_posts
FOR DELETE TO authenticated
USING (private.is_admin());

-- 5. Create the public flyer bucket, limited to 5 MB
INSERT INTO storage.buckets (
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
)
VALUES (
    'news-flyers',
    'news-flyers',
    true,
    5242880,
    ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = 5242880,
    allowed_mime_types =
        ARRAY['image/jpeg', 'image/png', 'image/webp'];

-- 6. Only administrators can upload flyers
DROP POLICY IF EXISTS news_flyers_admin_insert
ON storage.objects;

CREATE POLICY news_flyers_admin_insert
ON storage.objects
FOR INSERT TO authenticated
WITH CHECK (
    bucket_id = 'news-flyers'
    AND private.is_admin()
);

-- Only administrators can replace flyer objects
DROP POLICY IF EXISTS news_flyers_admin_update
ON storage.objects;

CREATE POLICY news_flyers_admin_update
ON storage.objects
FOR UPDATE TO authenticated
USING (
    bucket_id = 'news-flyers'
    AND private.is_admin()
)
WITH CHECK (
    bucket_id = 'news-flyers'
    AND private.is_admin()
);

-- Only administrators can delete flyer objects
DROP POLICY IF EXISTS news_flyers_admin_delete
ON storage.objects;

CREATE POLICY news_flyers_admin_delete
ON storage.objects
FOR DELETE TO authenticated
USING (
    bucket_id = 'news-flyers'
    AND private.is_admin()
);

-- 7. Indexes for common news-page queries
CREATE INDEX IF NOT EXISTS news_posts_published_created_idx
ON public.news_posts (created_at DESC)
WHERE is_published = true;

CREATE INDEX IF NOT EXISTS news_posts_programme_date_idx
ON public.news_posts (event_date)
WHERE post_type = 'programme'
  AND is_published = true;