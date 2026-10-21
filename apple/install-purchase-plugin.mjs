// Keep native purchase code in the generated app's existing source group.
import { readFileSync, writeFileSync } from 'node:fs';
const app = new URL('./ios/App/App/', import.meta.url);
const delegate = new URL('AppDelegate.swift', app);
const plugin = readFileSync(new URL('./native/PurchasePlugin.swift', import.meta.url), 'utf8');
const source = readFileSync(delegate, 'utf8');
if (!source.includes('class PurchasePlugin:')) writeFileSync(delegate, `${source}\n${plugin}`);
const scene = new URL('SceneDelegate.swift', app);
const original = readFileSync(scene, 'utf8');
if (!original.includes('CAPBridgeViewController()') && !original.includes('PurchaseViewController()')) throw new Error('The Capacitor scene template changed');
writeFileSync(scene, original.replace('CAPBridgeViewController()', 'PurchaseViewController()'));
const storyboard = new URL('Base.lproj/Main.storyboard', app);
writeFileSync(storyboard, readFileSync(storyboard, 'utf8').replace('customClass="CAPBridgeViewController" customModule="Capacitor"', 'customClass="PurchaseViewController" customModule="App"'));
// StoreKit AppTransaction requires iOS 16. The generated Capacitor template still targets iOS 15.
const project = new URL('./ios/App/App.xcodeproj/project.pbxproj', import.meta.url);
writeFileSync(project, readFileSync(project, 'utf8').replaceAll('IPHONEOS_DEPLOYMENT_TARGET = 15.0;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;'));
