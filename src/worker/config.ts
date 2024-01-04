import dotenv from 'dotenv';

dotenv.config({
    path: '.env.dist',
});
dotenv.config({
    path: '.env',
    override: true,
});
