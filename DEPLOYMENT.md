# Deployment Guide for Wrong Question Notebook

This guide will help you deploy the Wrong Question Notebook application to Vercel.

## Prerequisites

1. **Vercel Account**: Sign up at [vercel.com](https://vercel.com)
2. **Supabase Project**: Set up a Supabase project at [supabase.com](https://supabase.com)
3. **Git Repository**: Push your code to GitHub, GitLab, or Bitbucket

## Pre-Deployment Checklist

✅ **Security Audit**: No vulnerabilities found in dependencies
✅ **Build Test**: Application builds successfully
✅ **TypeScript**: All type errors resolved
✅ **Linting**: Code follows project standards
✅ **Tests**: All Vitest test suites pass
✅ **Configuration**: Production-ready Next.js config

Run `npm run prepush` from the `web/` directory to verify all checks pass before deploying.

## Step 1: Set Up Supabase

1. **Create a new Supabase project**:
    - Go to [supabase.com](https://supabase.com)
    - Click "New Project"
    - Choose your organization and create the project

2. **Get your project credentials**:
    - Go to Settings → API
    - Copy your Project URL and anon/public key

3. **Set up your database schema** (if not already done):
    - The application expects tables for subjects, problems, tags, attempts, problem sets, review sessions, profiles, user activity logs, admin settings, and usage quotas
    - Refer to your database migration files or schema documentation

## Step 2: Deploy to Vercel

### Option A: Deploy via Vercel Dashboard (Recommended)

1. **Connect your repository**:
    - Go to [vercel.com/dashboard](https://vercel.com/dashboard)
    - Click "New Project"
    - Import your Git repository

2. **Configure the project**:
    - **Framework Preset**: Next.js
    - **Root Directory**: `web` (if your Next.js app is in the web folder)
    - **Build Command**: `npm run build`
    - **Output Directory**: `.next` (default)

3. **Set environment variables** (see [Environment Variables Reference](#environment-variables-reference) for the full list):

    ```env
    NEXT_PUBLIC_SUPABASE_URL=your_supabase_project_url
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY=your_supabase_anon_key
    SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
    GEMINI_API_KEY=your_gemini_api_key
    ```

4. **Deploy**:
    - Click "Deploy"
    - Wait for the build to complete

### Option B: Deploy via Vercel CLI

1. **Install Vercel CLI**:

    ```bash
    npm i -g vercel
    ```

2. **Login to Vercel**:

    ```bash
    vercel login
    ```

3. **Navigate to your project**:

    ```bash
    cd web
    ```

4. **Deploy**:

    ```bash
    vercel
    ```

5. **Set environment variables**:

    ```bash
    vercel env add NEXT_PUBLIC_SUPABASE_URL
    vercel env add NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY
    vercel env add SUPABASE_SERVICE_ROLE_KEY
    vercel env add GEMINI_API_KEY
    ```

6. **Redeploy with environment variables**:

    ```bash
    vercel --prod
    ```

## Step 3: Configure Domain (Optional)

1. **Add custom domain**:
    - Go to your project dashboard on Vercel
    - Navigate to Settings → Domains
    - Add your custom domain
    - Follow the DNS configuration instructions

2. **Update environment variables**:
    - Update `SITE_URL` in your environment variables to match your domain

## Step 4: Post-Deployment Verification

1. **Test the application**:
    - Visit your deployed URL
    - Test user registration and login (Turnstile CAPTCHA should appear)
    - Create a notebook and add problems
    - Verify file uploads work correctly
    - Test problem review sessions and auto-marking
    - Check that the statistics dashboard loads
    - Verify cookie consent banner appears on first visit
    - (If admin) Confirm the admin panel is accessible

2. **Check logs**:
    - Monitor Vercel function logs for any errors
    - Check Supabase logs for database issues

3. **Performance check**:
    - Run Lighthouse audit
    - Check Core Web Vitals

## Environment Variables Reference

| Variable                                       | Description                                       | Required |
| ---------------------------------------------- | ------------------------------------------------- | -------- |
| `NEXT_PUBLIC_SUPABASE_URL`                     | Supabase project URL                              | Yes      |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_OR_ANON_KEY` | Supabase anon / public key                        | Yes      |
| `SUPABASE_SERVICE_ROLE_KEY`                    | Supabase service role key (server-side admin)     | Yes      |
| `SITE_URL`                                     | Deployed site URL (for sitemap generation)        | No       |
| `GEMINI_API_KEY`                               | Google Gemini API key (for AI problem extraction) | No       |

## Security Considerations

✅ **Headers**: Security headers configured in `next.config.ts` (HSTS, CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy, Permissions-Policy)
✅ **CAPTCHA**: Cloudflare Turnstile on login and registration forms
✅ **HTML Sanitisation**: DOMPurify + sanitize-html with math content support
✅ **Rate Limiting**: Applied to sensitive API endpoints
✅ **Input Validation**: Zod schemas validate all API request bodies
✅ **CORS**: Properly configured for Supabase
✅ **Authentication**: Supabase Auth with middleware session refresh on every request
✅ **Authorisation**: Role-based access control (user, moderator, admin, super_admin)
✅ **File Uploads**: Secure file handling with Supabase Storage and user-scoped access
✅ **Cookie Consent**: GDPR-compliant consent banner; analytics loaded only after user opt-in

## Troubleshooting

### Common Issues

1. **Build Failures**:
    - Check that all environment variables are set
    - Ensure TypeScript compilation passes locally
    - Verify all dependencies are installed

2. **Authentication Issues**:
    - Verify Supabase URL and keys are correct
    - Check Supabase project is active
    - Ensure RLS policies are properly configured

3. **File Upload Issues**:
    - Verify Supabase Storage is enabled
    - Check storage bucket permissions
    - Ensure file size limits are appropriate

4. **Database Connection Issues**:
    - Verify database is accessible
    - Check connection pooling settings
    - Review Supabase project status

### Getting Help

- Check Vercel deployment logs
- Review Supabase project logs
- Test locally with production environment variables
- Consult Next.js and Supabase documentation

## Monitoring and Maintenance

1. **Set up monitoring**:
    - Vercel Analytics and Speed Insights are integrated (loaded conditionally after cookie consent)
    - Set up error tracking (Sentry, etc.) if desired
    - Monitor Supabase usage and limits
    - Check the admin panel's statistics dashboard for platform-wide metrics

2. **Regular maintenance**:
    - Keep dependencies updated
    - Monitor security advisories
    - Review and rotate API keys periodically

## Production Optimizations

The application includes several production optimizations:

- **Image Optimization**: Next.js Image component with WebP/AVIF support
- **Bundle Optimization**: Package imports optimized for lucide-react
- **Security Headers**: HSTS, X-Frame-Options, X-Content-Type-Options, CSP, Referrer-Policy, Permissions-Policy
- **SEO**: Automatic sitemap and robots.txt generation via `next-sitemap` (runs on `postbuild`)
- **Conditional Analytics**: Vercel Analytics and Speed Insights loaded only after cookie consent
- **Turbopack**: Used in development for faster rebuilds (Next.js 16)

## Support

For issues specific to this application, check the project's GitHub repository or contact the development team.
