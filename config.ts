import dotenv from 'dotenv';
import path from 'path';

// Priority: process env (i.e set by run-worker.sh), then .env, then .env.dist
dotenv.config({
    path: path.join(__dirname, '.env'),
});
dotenv.config({
    path: path.join(__dirname, '.env.dist'),
});
