The easiest way to set up the development environment is to use the [`bin/setup` script](bin/setup), but feel free to run the commands in it yourself to:

- Set up Ruby (ideally using `rbenv`/`rvm`) and PostgreSQL
- Install dependencies using `pnpm i` and `cd apps/rails && bundle i`
- Set up your environment by either using `pnpx vercel env pull` or `cp .env.example .env` and filling in missing values and your own keys
- Run `cd apps/rails && gem install foreman`

## Running the App

You can start the local app using the [`bin/dev` script](bin/dev) - or feel free to run the commands contained in it yourself.

Once the local services are up and running, the application will be available at `https://flexile.dev`

Check [the seeds](apps/rails/config/data/seed_templates/gumroad.json) for default data created during setup.

## Common Issues / Debugging

The easiest way to set up the development environment is to use the [`bin/setup` script](bin/setup), but feel free to run the commands in it yourself to:

- Set up Ruby (ideally using `rbenv`/`rvm`) and PostgreSQL
- Install dependencies using `pnpm i` and `cd apps/backend && bundle i`
- Set up your environment by either using `pnpx vercel env pull` or `cp .env.example .env` and filling in missing values and your own keys
- Run `cd apps/backend && gem install foreman`

## Running the App

You can start the local app using the [`bin/dev` script](bin/dev) - or feel free to run the commands contained in it yourself.

Once the local services are up and running, the application will be available at `https://flexile.dev`

Check [the seeds](apps/backend/config/data/seed_templates/gumroad.json) for default data created during setup.

## Common Issues / Debugging
