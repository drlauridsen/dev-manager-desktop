import {ChangeDetectionStrategy, Component, Host, Input, OnInit, TemplateRef, ViewChild} from '@angular/core';
import {NgbModal} from '@ng-bootstrap/ng-bootstrap';
import {AppsComponent} from '../apps.component';
import {RawPackageInfo} from '../../types';
import {
    CUSTOM_APPS_AI_PROMPT,
    CUSTOM_APPS_DIR_NAME,
    CUSTOM_APPS_HELP_JSON,
    CustomAppsResult,
    CustomAppsService
} from '../../core/services';

@Component({
    selector: 'app-custom',
    templateUrl: './custom.component.html',
    styleUrls: ['./custom.component.scss'],
    changeDetection: ChangeDetectionStrategy.Eager,
    standalone: false
})
export class CustomComponent implements OnInit {

    @Input()
    installed?: Record<string, RawPackageInfo>;

    @ViewChild('help', {static: true})
    help!: TemplateRef<unknown>;

    result?: CustomAppsResult;
    loadError?: Error;
    dirPath = '';
    copied = false;

    readonly dirName = CUSTOM_APPS_DIR_NAME;
    readonly exampleJson = CUSTOM_APPS_HELP_JSON;
    readonly aiPrompt = CUSTOM_APPS_AI_PROMPT;

    constructor(@Host() public parent: AppsComponent, private customApps: CustomAppsService,
                private modalService: NgbModal) {
    }

    ngOnInit(): void {
        this.reload();
    }

    reload(): void {
        this.loadError = undefined;
        this.customApps.dirPath().then(path => this.dirPath = path).catch(() => undefined);
        this.customApps.load().then(result => this.result = result)
            .catch(e => this.loadError = e as Error);
    }

    openFolder(): void {
        this.customApps.openDir().catch(e => this.loadError = e as Error);
    }

    openHelp(): void {
        this.modalService.open(this.help, {size: 'lg', scrollable: true});
    }

    copyPrompt(): void {
        navigator.clipboard.writeText(this.aiPrompt).then(() => {
            this.copied = true;
            setTimeout(() => this.copied = false, 2000);
        }).catch(() => undefined);
    }
}
